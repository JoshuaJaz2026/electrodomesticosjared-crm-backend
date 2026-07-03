require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: Falta DATABASE_URL en el archivo .env");
    process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

// 🌟 Inicializamos la IA de Gemini
const aiEnabled = !!process.env.GEMINI_API_KEY;
const genAI = aiEnabled ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
if (aiEnabled) console.log("🧠 ¡Asistente de IA (Gemini) configurado y listo!");

const app = express();
app.use(cors()); 

const mediaPath = path.join(__dirname, 'media');
if (!fs.existsSync(mediaPath)) {
    fs.mkdirSync(mediaPath);
}
app.use('/media', express.static(mediaPath));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }, 
    maxHttpBufferSize: 1e8 
});

const port = process.env.PORT || 3001; 

// 🌟 GESTOR MULTI-SESIÓN Y MEMORIA DE IA
const activeSessions = new Map(); 
const botStates = {}; 
const autoPilotStates = {}; 

async function processMedia(msg) {
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                const ext = media.mimetype.split('/')[1].split(';')[0];
                const filename = `${msg.id.id}.${ext}`;
                fs.writeFileSync(path.join(mediaPath, filename), media.data, 'base64');
                return { mediaUrl: `http://localhost:3001/media/${filename}`, mimeType: media.mimetype, body: msg.body || '' };
            }
        } catch (error) {}
    }
    return { mediaUrl: null, mimeType: null, body: msg.body || '[Mensaje no soportado]' };
}

// 🏭 FUNCIÓN FÁBRICA DE SESIONES DE WHATSAPP
const initializeWhatsAppSession = (sessionId) => {
    if (activeSessions.has(sessionId)) {
        console.log(`⚠️ La sesión ${sessionId} ya está activa.`);
        return;
    }

    console.log(`⏳ Inicializando sesión: ${sessionId}...`);

    const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'Ventas_Principal' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

    client.on('qr', (qr) => { 
        console.log(`📌 QR Generado para la sesión: ${sessionId}`);
        io.emit('whatsapp-qr', qr); 
        io.emit('qr', { sessionId, qr }); 
    });

    client.on('loading_screen', (percent, message) => {
        io.emit('session-loading', { sessionId, percent, message });
    });

    client.on('ready', () => { 
        console.log(`✅ ¡Línea de WhatsApp [${sessionId}] conectada y lista!`);
        io.emit('whatsapp-ready'); 
        io.emit('session-ready', { sessionId }); 
    });

    // 🛡️ BLOQUE BLINDADO CONTRA DESCONEXIONES Y CIERRES DE SESIÓN
    client.on('disconnected', async (reason) => { 
        console.log(`❌ Línea [${sessionId}] desconectada:`, reason);
        activeSessions.delete(sessionId);
        io.emit('whatsapp-disconnected'); 
        io.emit('session-disconnected', { sessionId });
        
        try {
            await client.destroy();
            console.log(`🧹 Sesión [${sessionId}] limpiada de la memoria.`);
        } catch (e) {
            console.log(`⚠️ Error menor limpiando la sesión [${sessionId}] (ya estaba cerrada).`);
        }
    });

    client.on('message_create', async message => {
        if (message.id._serialized.startsWith('NOTE_')) return;
        if (message.from.includes('@g.us') || message.to.includes('@g.us') || message.from === 'status@broadcast') return;

        const { mediaUrl, mimeType, body } = await processMedia(message);
        const summaryText = mediaUrl ? '[📷 Archivo Adjunto]' : body;
        const contactId = message.fromMe ? message.to : message.from; 

        try {
            let contactName = message._data?.notifyName || contactId.replace('@c.us', '');
            if (!message.fromMe && (!contactName || contactName === contactId.replace('@c.us', ''))) {
                try {
                    const contact = await message.getContact();
                    contactName = contact.name || contact.pushname || contactName;
                } catch (e) {}
            }
            
            await sql`INSERT INTO contacts (id, name, last_message, updated_at) VALUES (${contactId}, ${contactName}, ${summaryText}, NOW()) ON CONFLICT (id) DO UPDATE SET last_message = ${summaryText}, updated_at = NOW()`;
            await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, media_url, mime_type, ack) VALUES (${message.id._serialized}, ${contactId}, ${body}, ${message.fromMe}, to_timestamp(${message.timestamp}), ${mediaUrl}, ${mimeType}, ${message.ack}) ON CONFLICT (id) DO NOTHING`;
            
            io.emit('whatsapp-message', { id: message.id._serialized, from: contactId, contactName: contactName, summaryText: summaryText, body: body, mediaUrl, mimeType, ack: message.ack, timestamp: new Date(), isMine: message.fromMe });
        } catch (dbError) {}

        // 🛑 REGLA DE ORO: SI EL HUMANO ESCRIBE, APAGAR PILOTO AUTOMÁTICO
        if (message.fromMe) {
            delete botStates[contactId]; 
            if (autoPilotStates[contactId]) {
                autoPilotStates[contactId] = false;
                io.emit('autopilot-status', { chatId: contactId, isActive: false });
                console.log(`👤 Humano intervino. Piloto Automático APAGADO para: ${contactId}`);
            }
        } else {
            // 🚀 IA EN PILOTO AUTOMÁTICO
            if (autoPilotStates[contactId] && aiEnabled) {
                console.log(`🤖 Generando respuesta automática para: ${contactId}`);
                try {
                    const contextMsgs = await sql`SELECT body, is_mine FROM messages WHERE contact_id = ${contactId} ORDER BY timestamp DESC LIMIT 8`;
                    const chatHistory = contextMsgs.reverse().map(m => `${m.is_mine ? 'Asesor' : 'Cliente'}: ${m.body}`).join('\n');
                    const prompt = `Eres el mejor vendedor de "Electrodomésticos Jared". \nHistorial reciente:\n${chatHistory}\n\nCliente dice: "${body}". \nGenera una respuesta natural, persuasiva y corta para intentar cerrar la venta. Sin comillas al inicio ni al final.`;
                    
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    const result = await model.generateContent(prompt);
                    const aiReply = result.response.text().trim();
                    
                    const sentMsg = await client.sendMessage(contactId, aiReply);
                    await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) VALUES (${sentMsg.id._serialized}, ${contactId}, ${aiReply}, true, to_timestamp(${sentMsg.timestamp}), ${sentMsg.ack || 1}, 'Piloto Automático (IA)')`;
                    io.emit('whatsapp-message', { id: sentMsg.id._serialized, from: contactId, contactName: contactId.replace('@c.us', ''), summaryText: aiReply, body: aiReply, ack: sentMsg.ack || 1, timestamp: new Date(), isMine: true, agentName: 'Piloto Automático (IA)' });
                } catch (e) {
                    console.error("Error de IA:", e);
                }
                return; 
            }

            // 🤖 MENÚ NORMAL
            const text = (body || '').trim().toLowerCase();
            const isGreeting = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'info', 'informacion', 'menú', 'menu'].includes(text);

            let botConfig;
            try {
                const result = await sql`SELECT * FROM bot_settings LIMIT 1`;
                if (result.length > 0) botConfig = result[0];
            } catch (e) {}

            if (!botConfig) return; 

            if (isGreeting && !botStates[contactId]) {
                botStates[contactId] = { step: 'AWAITING_OPTION' };
                await client.sendMessage(contactId, botConfig.greeting_menu);
            } 
            else if (botStates[contactId] && botStates[contactId].step === 'AWAITING_OPTION') {
                if (text === '1') { 
                    botStates[contactId].step = 'AWAITING_PRODUCT'; 
                    await client.sendMessage(contactId, botConfig.opt1_reply); 
                }
                else if (text === '2') { 
                    botStates[contactId].step = 'AWAITING_DNI_SUPPORT'; 
                    await client.sendMessage(contactId, botConfig.opt2_reply); 
                }
                else if (text === '3') { 
                    botStates[contactId].step = 'AWAITING_ORDER'; 
                    await client.sendMessage(contactId, botConfig.opt3_reply); 
                }
                else if (text === '4') { 
                    delete botStates[contactId]; 
                    await client.sendMessage(contactId, botConfig.opt4_reply); 
                    await sql`UPDATE contacts SET label = 'Pendiente' WHERE id = ${contactId}`;
                    io.emit('label-updated', { chatId: contactId, label: 'Pendiente' });
                }
                else { await client.sendMessage(contactId, '❌ Opción no válida. Por favor, responde solo con un número del 1 al 4.'); }
            }
            else if (botStates[contactId] && botStates[contactId].step === 'AWAITING_PRODUCT') {
                const product = body;
                delete botStates[contactId];
                await client.sendMessage(contactId, `¡Anotado! 📝 Un asesor revisará el stock de *${product}* y te atenderá en un momento.`);
                await sql`UPDATE contacts SET label = 'Ventas' WHERE id = ${contactId}`;
                io.emit('label-updated', { chatId: contactId, label: 'Ventas' });
            }
            else if (botStates[contactId] && botStates[contactId].step === 'AWAITING_DNI_SUPPORT') {
                const dniInfo = body;
                delete botStates[contactId];
                await client.sendMessage(contactId, `Gracias. 🛠️ Un especialista revisará el documento/serie *${dniInfo}* y se pondrá en contacto contigo a la brevedad.`);
                await sql`UPDATE contacts SET label = 'Soporte/Garantía' WHERE id = ${contactId}`;
                io.emit('label-updated', { chatId: contactId, label: 'Soporte/Garantía' });
            }
            else if (botStates[contactId] && botStates[contactId].step === 'AWAITING_ORDER') {
                const orderInfo = body;
                delete botStates[contactId];
                await client.sendMessage(contactId, `Gracias. 🚚 Estamos verificando el estado del pedido *${orderInfo}*. Te responderemos en breve.`);
                await sql`UPDATE contacts SET label = 'Envíos' WHERE id = ${contactId}`;
                io.emit('label-updated', { chatId: contactId, label: 'Envíos' });
            }
        }
    });

    client.on('message_ack', async (msg, ack) => {
        try {
            await sql`UPDATE messages SET ack = ${ack} WHERE id = ${msg.id._serialized}`;
            io.emit('message-ack', { messageId: msg.id._serialized, ack: ack });
        } catch (error) {}
    });

    client.initialize();
    activeSessions.set(sessionId, client);
};

const getClient = (sessionId) => {
    if (sessionId && activeSessions.has(sessionId)) return activeSessions.get(sessionId);
    return activeSessions.get('Ventas_Principal') || Array.from(activeSessions.values())[0];
};

io.on('connection', (socket) => {
    const isReady = activeSessions.size > 0;
    if (isReady) socket.emit('whatsapp-ready');
    socket.on('check-status', () => { if (activeSessions.size > 0) socket.emit('whatsapp-ready'); });

    socket.on('get-sessions', () => {
        socket.emit('load-sessions', Array.from(activeSessions.keys()));
    });

    socket.on('start-session', ({ sessionId }) => {
        initializeWhatsAppSession(sessionId);
    });

    // ⚡ RECIBIR ORDEN DE ENCENDER/APAGAR PILOTO AUTOMÁTICO
    socket.on('toggle-autopilot', (data) => {
        autoPilotStates[data.chatId] = data.isActive;
        console.log(`🤖 Piloto Automático ${data.isActive ? 'ENCENDIDO' : 'APAGADO'} para: ${data.chatId}`);
    });

    socket.on('check-autopilot', (chatId) => {
        socket.emit('autopilot-status', { chatId, isActive: !!autoPilotStates[chatId] });
    });

    socket.on('ai-generate-reply', async (data) => {
        if (!aiEnabled) return socket.emit('ai-reply-error', 'La IA no está configurada.');
        try {
            const contextMsgs = await sql`SELECT body, is_mine FROM messages WHERE contact_id = ${data.chatId} ORDER BY timestamp DESC LIMIT 12`;
            const chatHistory = contextMsgs.reverse().map(m => `${m.is_mine ? 'Asesor' : 'Cliente'}: ${m.body}`).join('\n');
            const prompt = `Eres el asistente inteligente de "Electrodomésticos Jared"... \nHistorial del chat:\n${chatHistory}\n\nGenera la respuesta comercial ideal:`;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(prompt);
            socket.emit('ai-reply-success', { text: result.response.text() });
        } catch (error) { socket.emit('ai-reply-error', 'Error con Gemini.'); }
    });

    socket.on('ai-summarize-chat', async (data) => {
        if (!aiEnabled) return socket.emit('ai-summary-error', 'La IA no está configurada.');
        try {
            const contextMsgs = await sql`SELECT body, is_mine FROM messages WHERE contact_id = ${data.chatId} ORDER BY timestamp DESC LIMIT 30`;
            const chatHistory = contextMsgs.reverse().map(m => `${m.is_mine ? 'Asesor' : 'Cliente'}: ${m.body}`).join('\n');
            const prompt = `Crea un resumen corporativo súper conciso...\nHistorial:\n${chatHistory}`;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(prompt);
            socket.emit('ai-summary-success', { summary: result.response.text() });
        } catch (error) { socket.emit('ai-summary-error', 'Error generando resumen.'); }
    });

    socket.on('transcribe-audio', async (data) => {
        if (!aiEnabled) return socket.emit('ai-transcribe-error', 'La IA no está configurada.');
        try {
            const filename = data.mediaUrl.split('/').pop();
            const filePath = path.join(mediaPath, filename);
            if (fs.existsSync(filePath)) {
                const mediaData = fs.readFileSync(filePath, 'base64');
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                const prompt = "Transcribe este audio a texto. Responde ÚNICAMENTE con las palabras exactas del audio, sin introducciones.";
                const result = await model.generateContent([ prompt, { inlineData: { data: mediaData, mimeType: data.mimeType } } ]);
                socket.emit('ai-transcribe-success', { messageId: data.messageId, text: result.response.text() });
            } else { socket.emit('ai-transcribe-error', 'Archivo no encontrado.'); }
        } catch (error) { socket.emit('ai-transcribe-error', 'Error en transcripción.'); }
    });

    socket.on('login-attempt', async (data) => {
        try {
            const user = await sql`SELECT username, role FROM users WHERE username = ${data.username} AND password = ${data.password}`;
            if (user.length > 0) socket.emit('login-success', { username: user[0].username, role: user[0].role });
            else socket.emit('login-error', 'Usuario o contraseña incorrectos');
        } catch (error) { socket.emit('login-error', 'Error conectando a la BD.'); }
    });

    socket.on('get-users', async () => {
        try { const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; socket.emit('load-users', users); } catch (error) {}
    });

    socket.on('get-stats', async () => {
        try {
            const labelsQuery = await sql`SELECT label, COUNT(*) as count FROM contacts WHERE label IS NOT NULL GROUP BY label`;
            const agentsQuery = await sql`SELECT agent_name, COUNT(*) as count FROM messages WHERE agent_name IS NOT NULL GROUP BY agent_name ORDER BY count DESC`;
            socket.emit('load-stats', { labels: labelsQuery, agents: agentsQuery });
        } catch (error) {}
    });

    socket.on('get-reminders', async () => {
        try {
            const reminders = await sql`SELECT r.id, r.contact_id, c.name as contact_name, r.agent_name, r.description, r.due_date, r.is_completed FROM reminders r LEFT JOIN contacts c ON r.contact_id = c.id ORDER BY r.due_date ASC`;
            socket.emit('load-reminders', reminders);
        } catch (error) {}
    });

    socket.on('get-activity-logs', async (contactId) => {
        try { const logs = await sql`SELECT * FROM activity_logs WHERE contact_id = ${contactId} ORDER BY created_at DESC`; socket.emit('load-activity-logs', logs); } catch (error) {}
    });

    socket.on('add-activity-log', async (data) => {
        try {
            await sql`INSERT INTO activity_logs (contact_id, agent_name, action_type, description) VALUES (${data.contactId}, ${data.agentName}, ${data.actionType}, ${data.description})`;
            const logs = await sql`SELECT * FROM activity_logs WHERE contact_id = ${data.contactId} ORDER BY created_at DESC`;
            io.emit('load-activity-logs', logs);
        } catch (error) {}
    });

    socket.on('get-products', async () => {
        try { const products = await sql`SELECT * FROM products ORDER BY category, name ASC`; socket.emit('load-products', products); } catch (error) {}
    });

    socket.on('add-product', async (data) => {
        try {
            await sql`INSERT INTO products (name, price, stock, category, image) VALUES (${data.name}, ${data.price}, ${data.stock}, ${data.category}, ${data.image})`;
            const products = await sql`SELECT * FROM products ORDER BY category, name ASC`;
            io.emit('load-products', products);
        } catch (error) {}
    });

    socket.on('delete-product', async (id) => {
        try {
            await sql`DELETE FROM products WHERE id = ${id}`;
            const products = await sql`SELECT * FROM products ORDER BY category, name ASC`;
            io.emit('load-products', products);
        } catch (error) {}
    });
    
    socket.on('add-reminder', async (data) => {
        try {
            await sql`INSERT INTO reminders (contact_id, agent_name, description, due_date) VALUES (${data.contactId}, ${data.agentName}, ${data.description}, ${data.dueDate})`;
            const reminders = await sql`SELECT r.id, r.contact_id, c.name as contact_name, r.agent_name, r.description, r.due_date, r.is_completed FROM reminders r LEFT JOIN contacts c ON r.contact_id = c.id ORDER BY r.due_date ASC`;
            io.emit('load-reminders', reminders);
        } catch (error) {}
    });

    socket.on('toggle-reminder', async (data) => {
        try {
            await sql`UPDATE reminders SET is_completed = ${data.isCompleted} WHERE id = ${data.id}`;
            const reminders = await sql`SELECT r.id, r.contact_id, c.name as contact_name, r.agent_name, r.description, r.due_date, r.is_completed FROM reminders r LEFT JOIN contacts c ON r.contact_id = c.id ORDER BY r.due_date ASC`;
            io.emit('load-reminders', reminders);
        } catch (error) {}
    });

    socket.on('create-user', async (data) => {
        try {
            await sql`INSERT INTO users (username, password, role) VALUES (${data.username}, ${data.password}, ${data.role})`;
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`;
            io.emit('load-users', users);
        } catch (error) { socket.emit('user-error', 'El usuario ya existe.'); }
    });

    socket.on('delete-user', async (id) => {
        try {
            await sql`DELETE FROM users WHERE id = ${id}`;
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`;
            io.emit('load-users', users);
        } catch (error) {}
    });

    socket.on('get-tickets', async (contactId) => {
        try { const tickets = await sql`SELECT * FROM tickets WHERE contact_id = ${contactId} ORDER BY created_at DESC`; socket.emit('load-tickets', tickets); } catch (error) {}
    });

    socket.on('create-ticket', async (data) => {
        try {
            await sql`INSERT INTO tickets (contact_id, agent_name, subject, description, serial_number, status) VALUES (${data.contactId}, ${data.agentName}, ${data.subject}, ${data.description}, ${data.serialNumber}, 'Abierto')`;
            const tickets = await sql`SELECT * FROM tickets WHERE contact_id = ${data.contactId} ORDER BY created_at DESC`;
            io.emit('load-tickets', tickets);
        } catch (error) {}
    });

    socket.on('update-ticket-status', async (data) => {
        try {
            await sql`UPDATE tickets SET status = ${data.status} WHERE id = ${data.id}`;
            const tickets = await sql`SELECT * FROM tickets WHERE contact_id = ${data.contactId} ORDER BY created_at DESC`;
            io.emit('load-tickets', tickets);
        } catch (error) {}
    });

    socket.on('assign-agent', async (data) => {
        try {
            const agent = data.agentName === '' ? null : data.agentName;
            await sql`UPDATE contacts SET assigned_to = ${agent} WHERE id = ${data.chatId}`;
            io.emit('agent-assigned', { chatId: data.chatId, agentName: agent });
        } catch (error) {}
    });

    socket.on('get-bot-settings', async () => {
        try {
            const settings = await sql`SELECT * FROM bot_settings LIMIT 1`;
            if (settings.length > 0) socket.emit('load-bot-settings', settings[0]);
        } catch (error) {}
    });

    socket.on('update-bot-settings', async (data) => {
        try {
            await sql`UPDATE bot_settings SET greeting_menu = ${data.greeting_menu}, opt1_reply = ${data.opt1_reply}, opt2_reply = ${data.opt2_reply}, opt3_reply = ${data.opt3_reply}, opt4_reply = ${data.opt4_reply}`;
            const settings = await sql`SELECT * FROM bot_settings LIMIT 1`;
            io.emit('load-bot-settings', settings[0]);
        } catch (error) {}
    });

    socket.on('request-chats', async (data) => {
        const client = getClient(data?.sessionId);
        if (!client || !client.info) return;

        try {
            // 1. Obtener chats activos
            const allChats = await client.getChats();
            const validChats = allChats.filter(c => !c.id._serialized.includes('@broadcast') && !c.id._serialized.includes('@g.us') && !c.id._serialized.includes('@lid'));
            
            // 2. Obtener contactos de la libreta (Para forzar sincronización)
            const allContacts = await client.getContacts();
            const savedContacts = allContacts.filter(c => c.isMyContact && !c.id._serialized.includes('@g.us'));

            // 3. Fusionar Chats + Contactos
            const chatIds = new Set(validChats.map(c => c.id._serialized));
            
            savedContacts.forEach(contact => {
                if (!chatIds.has(contact.id._serialized)) {
                    validChats.push({
                        id: contact.id,
                        name: contact.name || contact.pushname || contact.number,
                        lastMessage: { body: 'Sin mensajes recientes', timestamp: 0 },
                        timestamp: 0,
                        getContact: async () => contact 
                    });
                }
            });

            // 4. Ordenar todo
            const sortedChats = validChats.sort((a, b) => {
                const timeA = a.timestamp || (a.lastMessage ? a.lastMessage.timestamp : 0);
                const timeB = b.timestamp || (b.lastMessage ? b.lastMessage.timestamp : 0);
                return timeB - timeA;
            });
            
            const dbContacts = await sql`SELECT id, label, full_name, document_id, email, alt_phone, address, district, reference, customer_type, assigned_to FROM contacts`;
            const contactsMap = {};
            dbContacts.forEach(c => contactsMap[c.id] = c);

            let processed = 0;
            const totalChats = sortedChats.length;
            const cleanChats = []; 

            for (const c of sortedChats) {
                const dbInfo = contactsMap[c.id._serialized] || {};
                let chatName = c.name;

                if (!chatName || chatName === c.id.user) {
                    try {
                        const contact = await c.getContact();
                        chatName = contact.name || contact.pushname || c.id.user;
                    } catch (e) {}
                }

                processed++;
                const currentPercent = Math.floor((processed / totalChats) * 100);
                if (currentPercent % 5 === 0 || processed === totalChats) {
                     socket.emit('session-loading', { sessionId: data?.sessionId || 'Ventas_Principal', percent: currentPercent, message: `Sincronizando perfil ${processed} de ${totalChats}...` });
                }

                cleanChats.push({
                    id: c.id._serialized, 
                    name: chatName || c.id.user,
                    lastMessage: c.lastMessage ? (c.lastMessage.hasMedia ? '[📷 Archivo Adjunto]' : c.lastMessage.body) : 'Sin mensajes recientes',
                    label: dbInfo.label || null, 
                    assignedTo: dbInfo.assigned_to || null,
                    timestamp: c.timestamp || (c.lastMessage ? c.lastMessage.timestamp : 0),
                    crmData: { fullName: dbInfo.full_name || '', documentId: dbInfo.document_id || '', email: dbInfo.email || '', altPhone: dbInfo.alt_phone || '', address: dbInfo.address || '', district: dbInfo.district || '', reference: dbInfo.reference || '', customerType: dbInfo.customer_type || '' }
                });
            }
            socket.emit('load-chats', cleanChats);
        } catch (error) { 
            console.log('⏳ Esperando a que WhatsApp termine de sincronizar...'); 
        }
    });

    socket.on('update-label', async (data) => {
        try {
            await sql`INSERT INTO contacts (id, name, label) VALUES (${data.chatId}, ${data.chatId}, ${data.label}) ON CONFLICT (id) DO UPDATE SET label = ${data.label}`;
            io.emit('label-updated', { chatId: data.chatId, label: data.label });
        } catch (error) {}
    });

    socket.on('update-contact-info', async (data) => {
        try {
            await sql`INSERT INTO contacts (id, name, full_name, document_id, email, alt_phone, address, district, reference, customer_type) VALUES (${data.chatId}, ${data.chatId}, ${data.fullName}, ${data.documentId}, ${data.email}, ${data.altPhone}, ${data.address}, ${data.district}, ${data.reference}, ${data.customerType}) ON CONFLICT (id) DO UPDATE SET full_name = ${data.fullName}, document_id = ${data.documentId}, email = ${data.email}, alt_phone = ${data.altPhone}, address = ${data.address}, district = ${data.district}, reference = ${data.reference}, customer_type = ${data.customerType}, updated_at = NOW()`;
            io.emit('contact-info-updated', data);
        } catch (error) {}
    });

    socket.on('request-history', async (chatId, sessionId) => {
        const client = getClient(sessionId);
        try {
            let rawData = await sql`SELECT id, contact_id as from, body, is_mine, is_note, media_url, mime_type, ack, agent_name, EXTRACT(EPOCH FROM timestamp) as unix_ts FROM messages WHERE contact_id = ${chatId} ORDER BY timestamp ASC`;
            let dbMessages = rawData.map(m => ({ id: m.id, from: m.from, body: m.body, isMine: m.is_mine === true || m.is_mine === 'true' || m.is_mine === 't', isNote: m.is_note === true, mediaUrl: m.media_url, mimeType: m.mime_type, ack: m.ack, agentName: m.agent_name, timestamp: new Date(m.unix_ts * 1000).toISOString() }));
            if (dbMessages.length > 0) socket.emit('load-history', { chatId, messages: dbMessages });
            
            if (!client) return;
            const chat = await client.getChatById(chatId);
            if (!chat) return; 
            await sql`INSERT INTO contacts (id, name) VALUES (${chatId}, ${chat.name || chatId}) ON CONFLICT (id) DO NOTHING`;

            const rawMessages = await chat.fetchMessages({ limit: 50 });
            const fetchedIds = rawMessages.map(m => m.id._serialized);
            let existingIds = new Set();
            if (fetchedIds.length > 0) {
                const existingInDb = await sql`SELECT id FROM messages WHERE id = ANY(${fetchedIds})`;
                existingIds = new Set(existingInDb.map(m => m.id));
            }
            const newMessages = rawMessages.filter(m => !existingIds.has(m.id._serialized));

            if (newMessages.length > 0) {
                for (const msg of newMessages) {
                    const { mediaUrl, mimeType, body } = await processMedia(msg);
                    await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, media_url, mime_type, ack) VALUES (${msg.id._serialized}, ${chatId}, ${body}, ${msg.fromMe}, to_timestamp(${msg.timestamp}), ${mediaUrl}, ${mimeType}, ${msg.ack}) ON CONFLICT (id) DO NOTHING`;
                }
                let newRawData = await sql`SELECT id, contact_id as from, body, is_mine, is_note, media_url, mime_type, ack, agent_name, EXTRACT(EPOCH FROM timestamp) as unix_ts FROM messages WHERE contact_id = ${chatId} ORDER BY timestamp ASC`;
                dbMessages = newRawData.map(m => ({ id: m.id, from: m.from, body: m.body, isMine: m.is_mine === true || m.is_mine === 'true' || m.is_mine === 't', isNote: m.is_note === true, mediaUrl: m.media_url, mimeType: m.mime_type, ack: m.ack, agentName: m.agent_name, timestamp: new Date(m.unix_ts * 1000).toISOString() }));
                socket.emit('load-history', { chatId, messages: dbMessages });
            }
        } catch (error) {}
    });

    socket.on('send-message', async (data) => {
        const client = getClient(data.sessionId);
        if (!client) return;
        
        try {
            if (data.media) {
                const media = new MessageMedia(data.media.mimeType, data.media.data, data.media.name);
                const sentMsg = await client.sendMessage(data.to, media, { caption: data.text || '' });
                const ext = data.media.mimeType.split('/')[1].split(';')[0];
                const filename = `${sentMsg.id.id}.${ext}`;
                fs.writeFileSync(path.join(mediaPath, filename), data.media.data, 'base64');
                const mediaUrl = `http://localhost:3001/media/${filename}`;
                
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, media_url, mime_type, ack, agent_name) VALUES (${sentMsg.id._serialized}, ${data.to}, ${data.text}, true, to_timestamp(${sentMsg.timestamp}), ${mediaUrl}, ${data.media.mimeType}, ${sentMsg.ack || 1}, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET media_url = ${mediaUrl}, mime_type = ${data.media.mimeType}, agent_name = ${data.agentName}`;
                io.emit('whatsapp-message', { id: sentMsg.id._serialized, from: data.to, contactName: data.to.split('@')[0], summaryText: '[📷 Archivo Adjunto]', body: data.text, mediaUrl: mediaUrl, mimeType: data.media.mimeType, ack: sentMsg.ack || 1, timestamp: new Date(sentMsg.timestamp * 1000), isMine: true, agentName: data.agentName });
            } else {
                const sentMsg = await client.sendMessage(data.to, data.text);
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) VALUES (${sentMsg.id._serialized}, ${data.to}, ${data.text}, true, to_timestamp(${sentMsg.timestamp}), ${sentMsg.ack || 1}, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET agent_name = ${data.agentName}`;
            }
        } catch (error) {}
    });

    socket.on('send-note', async (data) => {
        try {
            const noteId = 'NOTE_' + Date.now(); 
            await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, is_note, agent_name) VALUES (${noteId}, ${data.to}, ${data.text}, true, NOW(), true, ${data.agentName})`;
        } catch (error) {}
    });

    // 🌐 GENERAR ENLACE DE COTIZACIÓN (LANDING PAGE)
    socket.on('create-quote', async (data) => {
        try {
            // Generar un ID único y corto, ej: COT-X7B9A
            const quoteId = 'COT-' + Math.random().toString(36).substring(2, 8).toUpperCase();

            // Guardar el carrito en la base de datos PostgreSQL
            await sql`INSERT INTO quotes (quote_id, contact_id, items, total, status) 
                      VALUES (${quoteId}, ${data.contactId}, ${JSON.stringify(data.items)}, ${data.total}, 'Pendiente')`;

            // Construir el enlace mágico (Usa localhost ahora, lo cambiaremos al subir a la nube)
            const quoteUrl = `http://localhost:3000/cotizacion/${quoteId}`;

            // Enviarle el enlace de vuelta al frontend para que lo mande por WhatsApp
            socket.emit('quote-created', { quoteId, quoteUrl, contactId: data.contactId, text: data.text });
            console.log(`✅ Cotización generada: ${quoteUrl}`);

        } catch (error) {
            console.error("❌ Error creando cotización:", error);
            socket.emit('quote-error', 'Hubo un error al generar el enlace de la cotización.');
        }
    });

});

initializeWhatsAppSession('Ventas_Principal');
server.listen(port, () => console.log(`🚀 Servidor del bot corriendo en el puerto ${port}`));
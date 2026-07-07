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

// 🏭 CONFIGURACIÓN MONOLÍTICA (1 SOLO NÚMERO) - PURGADA DE MULTISESIÓN
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // <- VITAL PARA RENDER: Evita que colapse la RAM
            '--disable-accelerated-2d-canvas', // Apaga el motor gráfico
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu' // Apaga la tarjeta de video que no usamos
        ]
    },
    webVersionCache: {
        type: 'none' 
    }
});

let isAuthenticated = false; // Escudo Anti-QR Fantasma

client.on('qr', (qr) => { 
    if (isAuthenticated) return; 
    console.log(`📌 QR Generado. Escanéalo en la terminal o en la pestaña 'Conexiones'.`);
    io.emit('whatsapp-qr', qr); 
});

client.on('authenticated', () => {
    isAuthenticated = true; 
    console.log(`🔐 Autenticación exitosa. Meta validó la sesión. Sincronizando historial...`);
    io.emit('whatsapp-ready'); // Obligamos al Frontend a ocultar el QR y saber que estamos listos
});

// 📢 RASTREADOR 1: Progreso de descarga desde WhatsApp (Meta)
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando sesión [Ventas_Principal]: ${percent}% - ${message}`);
    io.emit('session-loading', { percent, message });
});

client.on('ready', () => { 
    isAuthenticated = true; // Doble seguro
    console.log(`✅ ¡El bot está conectado y listo!`);
    io.emit('whatsapp-ready'); 
});

client.on('disconnected', async (reason) => { 
    isAuthenticated = false; 
    console.log(`❌ Línea desconectada: LOGOUT`);
    io.emit('whatsapp-disconnected'); 
    try { 
        await client.destroy(); 
        console.log(`🧹 Sesión limpiada de la memoria.`);
    } catch (e) {}
});

client.on('message_create', async message => {
    if (message.id._serialized.startsWith('NOTE_')) return;
    if (message.from === 'status@broadcast') return;

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

    if (message.fromMe) {
        delete botStates[contactId]; 
        if (autoPilotStates[contactId]) {
            autoPilotStates[contactId] = false;
            io.emit('autopilot-status', { chatId: contactId, isActive: false });
            console.log(`👤 Humano intervino. Piloto Automático APAGADO para: ${contactId}`);
        }
    } else {
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

io.on('connection', (socket) => {
    socket.on('check-status', () => { if (client.info) socket.emit('whatsapp-ready'); });

    socket.on('request-chats', async () => {
        if (!client.info) return;

        try {
            const allChats = await client.getChats();
            const validChats = allChats.filter(c => !c.id._serialized.includes('@broadcast') && !c.id._serialized.includes('@lid'));
            
            validChats.sort((a, b) => {
                const timeA = a.timestamp || (a.lastMessage ? a.lastMessage.timestamp : 0);
                const timeB = b.timestamp || (b.lastMessage ? b.lastMessage.timestamp : 0);
                return timeB - timeA;
            });

            const topChats = validChats.slice(0, 5);
            
            const dbContacts = await sql`SELECT id, label, full_name, document_id, email, alt_phone, address, district, reference, customer_type, assigned_to FROM contacts`;
            const contactsMap = {};
            dbContacts.forEach(c => contactsMap[c.id] = c);

            let processed = 0;
            const totalChats = topChats.length;
            const cleanChats = []; 

            for (const c of topChats) {
                const dbInfo = contactsMap[c.id._serialized] || {};
                let chatName = c.name;

                if (!c.isGroup && (!chatName || chatName === c.id.user)) {
                    try {
                        const contact = await c.getContact();
                        chatName = contact.name || contact.pushname || c.id.user;
                    } catch (e) {}
                }

                processed++;
                const currentPercent = Math.floor((processed / totalChats) * 100);
                
                io.emit('session-loading', { percent: currentPercent, message: `Sincronizando perfil ${processed} de ${totalChats}...` });

                cleanChats.push({
                    id: c.id._serialized, 
                    name: chatName || c.id.user,
                    lastMessage: c.lastMessage ? (c.lastMessage.hasMedia ? '[📷 Archivo Adjunto]' : c.lastMessage.body) : 'Sin mensajes recientes',
                    label: dbInfo.label || null, 
                    assignedTo: dbInfo.assigned_to || null,
                    timestamp: c.timestamp || (c.lastMessage ? c.lastMessage.timestamp : 0),
                    isGroup: c.isGroup,
                    crmData: { fullName: dbInfo.full_name || '', documentId: dbInfo.document_id || '', email: dbInfo.email || '', altPhone: dbInfo.alt_phone || '', address: dbInfo.address || '', district: dbInfo.district || '', reference: dbInfo.reference || '', customerType: dbInfo.customer_type || '' }
                });
            }
            
            socket.emit('load-chats', cleanChats);
            console.log(`✅ [CRM] ¡Sincronización de los ${totalChats} chats finalizada con éxito!`);
        } catch (error) { 
            console.log('⏳ Esperando a que WhatsApp termine de sincronizar...'); 
        }
    });

    socket.on('request-pairing-code', async (data) => {
        try {
            const code = await client.requestPairingCode(data.phoneNumber);
            socket.emit('pairing-code-success', { code });
        } catch (error) {
            socket.emit('pairing-error', 'Error al generar el código. Verifica el número o intenta con QR.');
        }
    });

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
            await sql`INSERT INTO products (name, brand, cost_price, price, stock, category, image) VALUES (${data.name}, ${data.brand}, ${data.costPrice}, ${data.price}, ${data.stock}, ${data.category}, ${data.image})`;
            const products = await sql`SELECT * FROM products ORDER BY category, name ASC`;
            io.emit('load-products', products);
        } catch (error) {
            console.error("Error al agregar producto:", error);
        }
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

    socket.on('get-all-contacts', async () => {
        try {
            const contacts = await sql`SELECT id, name, full_name, document_id, email, alt_phone, address, district, customer_type, label, TO_CHAR(updated_at, 'DD/MM/YYYY HH24:MI') as last_seen FROM contacts ORDER BY updated_at DESC`;
            socket.emit('load-all-contacts', contacts);
        } catch (error) {
            console.error("Error cargando directorio:", error);
        }
    });
    
    socket.on('get-all-quotes', async () => {
        try {
            const quotes = await sql`
                SELECT q.quote_id, q.contact_id, c.name as contact_name, q.items, q.total, q.status, TO_CHAR(q.created_at, 'DD/MM/YYYY HH24:MI') as date 
                FROM quotes q 
                LEFT JOIN contacts c ON q.contact_id = c.id 
                ORDER BY q.created_at DESC
            `;
            socket.emit('load-all-quotes', quotes);
        } catch (error) {
            console.error("Error cargando cotizaciones:", error);
        }
    });

    socket.on('update-quote-status', async (data) => {
        try {
            await sql`UPDATE quotes SET status = ${data.status} WHERE quote_id = ${data.quoteId}`;
            const quotes = await sql`
                SELECT q.quote_id, q.contact_id, c.name as contact_name, q.items, q.total, q.status, TO_CHAR(q.created_at, 'DD/MM/YYYY HH24:MI') as date 
                FROM quotes q 
                LEFT JOIN contacts c ON q.contact_id = c.id 
                ORDER BY q.created_at DESC
            `;
            io.emit('load-all-quotes', quotes);
        } catch (error) {
            console.error("Error actualizando cotización:", error);
        }
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

    socket.on('request-history', async (chatId) => {
        try {
            let rawData = await sql`SELECT id, contact_id as from, body, is_mine, is_note, media_url, mime_type, ack, agent_name, EXTRACT(EPOCH FROM timestamp) as unix_ts FROM messages WHERE contact_id = ${chatId} ORDER BY timestamp ASC`;
            let dbMessages = rawData.map(m => ({ id: m.id, from: m.from, body: m.body, isMine: m.is_mine === true || m.is_mine === 'true' || m.is_mine === 't', isNote: m.is_note === true, mediaUrl: m.media_url, mimeType: m.mime_type, ack: m.ack, agentName: m.agent_name, timestamp: new Date(m.unix_ts * 1000).toISOString() }));
            if (dbMessages.length > 0) socket.emit('load-history', { chatId, messages: dbMessages });
            
            if (!client.info) return;
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

    // ====================================================
    // ✅ EVENTO ACTUALIZADO: send-message (Textos y Medios)
    // ====================================================
    socket.on('send-message', async (data) => {
        if (!client.info) return;
        try {
            if (data.media) {
                const media = new MessageMedia(data.media.mimeType, data.media.data, data.media.name);
                const sentMsg = await client.sendMessage(data.to, media, { caption: data.text || '' });
                const ext = data.media.mimeType.split('/')[1].split(';')[0];
                const filename = `${sentMsg.id.id}.${ext}`;
                fs.writeFileSync(path.join(mediaPath, filename), data.media.data, 'base64');
                const mediaUrl = `http://localhost:3001/media/${filename}`;
                
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, media_url, mime_type, ack, agent_name) VALUES (${sentMsg.id._serialized}, ${data.to}, ${data.text}, true, to_timestamp(${sentMsg.timestamp}), ${mediaUrl}, ${data.media.mimeType}, ${sentMsg.ack || 1}, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET media_url = ${mediaUrl}, mime_type = ${data.media.mimeType}, agent_name = ${data.agentName}`;
                
                // Eco al CRM (Medios)
                io.emit('whatsapp-message', { id: sentMsg.id._serialized, from: data.to, contactName: data.to.split('@')[0], summaryText: '[📷 Archivo Adjunto]', body: data.text, mediaUrl: mediaUrl, mimeType: data.media.mimeType, ack: sentMsg.ack || 1, timestamp: new Date(sentMsg.timestamp * 1000), isMine: true, agentName: data.agentName });
            } else {
                const sentMsg = await client.sendMessage(data.to, data.text);
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) VALUES (${sentMsg.id._serialized}, ${data.to}, ${data.text}, true, to_timestamp(${sentMsg.timestamp}), ${sentMsg.ack || 1}, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET agent_name = ${data.agentName}`;
                
                // 🚀 ESTE ERA EL ESLABÓN PERDIDO: Eco al CRM (Textos normales y Cotizaciones)
                io.emit('whatsapp-message', {
                    id: sentMsg.id._serialized,
                    from: data.to,
                    contactName: data.to.split('@')[0],
                    summaryText: data.text,
                    body: data.text,
                    mediaUrl: null,
                    mimeType: null,
                    ack: sentMsg.ack || 1,
                    timestamp: new Date(sentMsg.timestamp * 1000),
                    isMine: true,
                    agentName: data.agentName
                });
            }
        } catch (error) {
            console.error("Error al enviar mensaje:", error);
        }
    });

    socket.on('send-note', async (data) => {
        try {
            const noteId = 'NOTE_' + Date.now(); 
            await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, is_note, agent_name) VALUES (${noteId}, ${data.to}, ${data.text}, true, NOW(), true, ${data.agentName})`;
        } catch (error) {}
    });

    // ==========================================
    // 🛒 CREACIÓN DE COTIZACIONES (URL PÚBLICA)
    // ==========================================
    socket.on('create-quote', async (data) => {
        try {
            const quoteId = 'COT-' + Math.random().toString(36).substring(2, 8).toUpperCase();
            await sql`INSERT INTO quotes (quote_id, contact_id, items, total, status) VALUES (${quoteId}, ${data.contactId}, ${JSON.stringify(data.items)}, ${data.total}, 'Pendiente')`;
            
            // 🚀 ACTUALIZADO: URL para que WhatsApp lo vuelva azul (clickeable)
            const quoteUrl = `https://jared-crm-frontend.onrender.com/cotizacion/${quoteId}`;
            
            socket.emit('quote-created', { quoteId, quoteUrl, contactId: data.contactId, text: data.text });
        } catch (error) { socket.emit('quote-error', 'Hubo un error.'); }
    });

});

server.listen(port, () => console.log(`🚀 Servidor del bot corriendo en el puerto ${port}`));
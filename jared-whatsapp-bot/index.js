require('dotenv').config();
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios'); // [cite: 14]

if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: Falta DATABASE_URL en el archivo .env");
    process.exit(1);
}
const sql = neon(process.env.DATABASE_URL); // [cite: 18, 19]

// Credenciales Oficiales de Meta leídas desde tu .env [cite: 74, 95]
const META_PHONE_ID = process.env.META_PHONE_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

const app = express();
app.use(cors()); 
app.use(express.json()); 

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }, 
    maxHttpBufferSize: 1e8 
});

const port = process.env.PORT || 3001; 

// ==========================================
// 🛡️ WEBHOOK DE META (VERIFICACIÓN DE SEGURIDAD) [cite: 80]
// ==========================================
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
            console.log('✅ WEBHOOK VERIFICADO POR META');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// ==========================================
// 📥 WEBHOOK DE META (RECEPCIÓN DE MENSAJES) [cite: 80, 81]
// ==========================================
app.post('/webhook', async (req, res) => {
    let body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            
            let msgObj = body.entry[0].changes[0].value.messages[0];
            let contactInfo = body.entry[0].changes[0].value.contacts?.[0];
            
            let phone = msgObj.from; 
            let text = msgObj.text ? msgObj.text.body : '[Mensaje no es texto]';
            let messageId = msgObj.id;
            let contactName = contactInfo?.profile?.name || phone;
            
            let contactId = phone + '@c.us';

            console.log(`📩 Mensaje Oficial recibido de ${contactName} (${phone}): ${text}`);

            try {
                await sql`INSERT INTO contacts (id, name, last_message, updated_at) VALUES (${contactId}, ${contactName}, ${text}, NOW()) ON CONFLICT (id) DO UPDATE SET last_message = ${text}, updated_at = NOW()`; // [cite: 78, 163]
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack) VALUES (${messageId}, ${contactId}, ${text}, false, NOW(), 1) ON CONFLICT (id) DO NOTHING`; // [cite: 78, 163]
                
                io.emit('whatsapp-message', { id: messageId, from: contactId, contactName: contactName, summaryText: text, body: text, mediaUrl: null, mimeType: null, ack: 1, timestamp: new Date(), isMine: false }); // [cite: 162]
            } catch (error) {
                console.error("Error BD recibiendo:", error);
            }
        }
        res.sendStatus(200); 
    } else {
        res.sendStatus(404);
    }
});

// ==========================================
// 📤 ENVÍO DE MENSAJES OFICIAL (CLOUD API) [cite: 74, 95]
// ==========================================
async function sendOfficialMessage(to_phone, text_message) {
    try {
        const cleanPhone = to_phone.replace('@c.us', '');
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v19.0/${META_PHONE_ID}/messages`,
            data: {
                messaging_product: 'whatsapp',
                to: cleanPhone,
                text: { body: text_message }
            },
            headers: {
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.messages[0].id;
    } catch (error) {
        console.error("❌ Error enviando mensaje oficial:", error.response ? error.response.data : error);
        return null;
    }
}

io.on('connection', (socket) => {
    // [cite: 161]
    socket.emit('whatsapp-ready'); 

    socket.on('request-chats', async () => {
        try {
            const dbContacts = await sql`SELECT id, name, last_message, label, full_name, document_id, email, alt_phone, address, district, reference, customer_type, assigned_to, EXTRACT(EPOCH FROM updated_at) as unix_ts FROM contacts ORDER BY updated_at DESC LIMIT 15`; // [cite: 18]
            
            const cleanChats = dbContacts.map(c => ({
                id: c.id, 
                name: c.name || c.id,
                lastMessage: c.last_message || 'Sin mensajes recientes',
                label: c.label || null, 
                assignedTo: c.assigned_to || null,
                timestamp: c.unix_ts,
                isGroup: false,
                crmData: { fullName: c.full_name || '', documentId: c.document_id || '', email: c.email || '', altPhone: c.alt_phone || '', address: c.address || '', district: c.district || '', reference: c.reference || '', customerType: c.customer_type || '' }
            }));
            socket.emit('load-chats', cleanChats);
        } catch (error) {}
    });

    socket.on('request-history', async (chatId) => {
        try {
            let rawData = await sql`SELECT id, contact_id as from, body, is_mine, is_note, media_url, mime_type, ack, agent_name, EXTRACT(EPOCH FROM timestamp) as unix_ts FROM messages WHERE contact_id = ${chatId} ORDER BY timestamp ASC`; // [cite: 18]
            let dbMessages = rawData.map(m => ({ id: m.id, from: m.from, body: m.body, isMine: m.is_mine === true || m.is_mine === 'true' || m.is_mine === 't', isNote: m.is_note === true, mediaUrl: m.media_url, mimeType: m.mime_type, ack: m.ack, agentName: m.agent_name, timestamp: new Date(m.unix_ts * 1000).toISOString() }));
            socket.emit('load-history', { chatId, messages: dbMessages });
        } catch (error) {}
    });

    socket.on('send-message', async (data) => {
        try {
            const metaMessageId = await sendOfficialMessage(data.to, data.text);
            if(metaMessageId) {
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) VALUES (${metaMessageId}, ${data.to}, ${data.text}, true, NOW(), 1, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET agent_name = ${data.agentName}`; // [cite: 78, 163]
                
                io.emit('whatsapp-message', { // [cite: 161, 162]
                    id: metaMessageId,
                    from: data.to,
                    contactName: data.to.split('@')[0],
                    summaryText: data.text,
                    body: data.text,
                    mediaUrl: null,
                    mimeType: null,
                    ack: 1,
                    timestamp: new Date(),
                    isMine: true,
                    agentName: data.agentName
                });
            }
        } catch (error) {}
    });

    socket.on('login-attempt', async (data) => {
        try {
            const user = await sql`SELECT username, role FROM users WHERE username = ${data.username} AND password = ${data.password}`; // [cite: 18]
            if (user.length > 0) socket.emit('login-success', { username: user[0].username, role: user[0].role });
            else socket.emit('login-error', 'Usuario o contraseña incorrectos');
        } catch (error) {}
    });

    // Gestión de usuarios: listar, crear, eliminar [cite: 244]
    socket.on('get-users', async () => {
        try {
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; // [cite: 18, 245]
            socket.emit('load-users', users);
        } catch (error) {}
    });

    socket.on('create-user', async (data) => {
        try {
            await sql`INSERT INTO users (username, password, role) VALUES (${data.username}, ${data.password}, ${data.role})`; // [cite: 18, 245]
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; // [cite: 18, 245]
            io.emit('load-users', users);
        } catch (error) {
             socket.emit('user-error', 'El usuario ya existe.');
        }
    });

    socket.on('delete-user', async (id) => {
        try {
            await sql`DELETE FROM users WHERE id = ${id}`; // [cite: 18, 245]
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; // [cite: 18, 245]
            io.emit('load-users', users);
        } catch (error) {}
    });

});

server.listen(port, () => console.log(`🚀 Servidor Ultraligero (Cloud API) corriendo en puerto ${port}`));
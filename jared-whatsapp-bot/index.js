require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const { createServer } = require('http');
const { neon } = require('@neondatabase/serverless');
const axios = require('axios');

// ---------------------------------------------------------------------------------
// 1. CONFIGURACIÓN DEL SERVIDOR WEB Y WEBSOCKETS (El "Túnel")
// ---------------------------------------------------------------------------------
const app = express();
// Middleware vital para que el webhook entienda los mensajes de Meta
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8 
});

const port = process.env.PORT || 3001;

// ---------------------------------------------------------------------------------
// 2. CONEXIÓN A LA BASE DE DATOS (Neon - PostgreSQL)
// ---------------------------------------------------------------------------------
const sql = neon(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------------
// 3. LA MAGIA OFICIAL DE META (Webhooks y API Cloud)
// ---------------------------------------------------------------------------------

const META_PHONE_ID = process.env.META_PHONE_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN; // "jared_crm_secreto_123"

// --- ENDPOINT: VALIDACIÓN INICIAL DEL WEBHOOK ---
app.get("/webhook", (req, res) => {
  console.log("🔔 [Meta] Intentando validar el Webhook...");
  
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === META_VERIFY_TOKEN) { 
      console.log("✅ [Meta] Webhook verificado exitosamente!");
      res.status(200).send(challenge);
    } else {
      console.log("❌ [Meta] Falló la verificación. Tokens no coinciden.");
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Variable global para recordar de quién es el turno (Round-Robin)
let turnoActualIndex = 0; 

// --- ENDPOINT: RECEPCIÓN DE MENSAJES EN TIEMPO REAL ---
app.post("/webhook", async (req, res) => {
  // Responde inmediatamente con "200 OK" para que Meta no te bloquee
  res.sendStatus(200);

  let body = req.body;

  // 🚨 EL RASTREADOR DE RAYOS X: Imprime todo lo crudo que llega de Meta
  console.log("\n📦 [Meta] PAQUETE RECIBIDO EN BRUTO:", JSON.stringify(body, null, 2));

  try {
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      
      let msgObj = body.entry[0].changes[0].value.messages[0]; 
      let contactInfo = body.entry[0].changes[0].value.contacts?.[0]; 
      
      let incomingNumber = msgObj.from; 
      let pushName = contactInfo?.profile?.name || incomingNumber; 
      let text = msgObj.text ? msgObj.text.body : '[Mensaje no es texto]'; 
      let messageId = msgObj.id; 
      
      let contactId = incomingNumber + '@c.us'; 

      console.log(`💬 [Meta] Nuevo mensaje de ${pushName} (${incomingNumber}): ${text}`); 

      // 1. REVISAR SI EL CLIENTE YA EXISTE
      let clienteExistente = await sql`SELECT assigned_to FROM contacts WHERE id = ${contactId}`;
      let asesorAsignado = null;

      if (clienteExistente.length > 0 && clienteExistente[0].assigned_to) {
          // El cliente ya es antiguo, se queda con el asesor que ya tenía
          asesorAsignado = clienteExistente[0].assigned_to;
      } else {
          // 2. ¡ES UN CLIENTE NUEVO! A REPARTIR (ROUND-ROBIN)
          let asesores = await sql`SELECT username FROM users WHERE role = 'Agente' ORDER BY id ASC`;

          if (asesores.length > 0) {
              // Le damos el cliente al asesor que le toca el turno
              asesorAsignado = asesores[turnoActualIndex].username;
              console.log(`🎰 ¡Nuevo Lead! Asignado automáticamente a: ${asesorAsignado}`);

              // Movemos la ruleta para el siguiente turno
              turnoActualIndex++;
              
              // Si la ruleta llegó al último asesor, la reiniciamos al primero
              if (turnoActualIndex >= asesores.length) {
                  turnoActualIndex = 0; 
              }
          }
      }

      // 3. GUARDAR EL CLIENTE CON SU ASESOR ASIGNADO
      await sql`
        INSERT INTO contacts (id, name, last_message, updated_at, assigned_to) 
        VALUES (${contactId}, ${pushName}, ${text}, NOW(), ${asesorAsignado}) 
        ON CONFLICT (id) DO UPDATE 
        SET last_message = ${text}, updated_at = NOW()
      `; 
      
      // 4. GUARDAR EL MENSAJE EN EL HISTORIAL
      await sql`
        INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack) 
        VALUES (${messageId}, ${contactId}, ${text}, false, NOW(), 1) 
        ON CONFLICT (id) DO NOTHING
      `; 
      
      io.emit('whatsapp-message', { id: messageId, from: contactId, contactName: pushName, summaryText: text, body: text, mediaUrl: null, mimeType: null, ack: 1, timestamp: new Date(), isMine: false }); 
    }
  } catch (error) {
    console.error("Error procesando Webhook:", error); 
  }
});

// ==========================================
// 📤 ENVÍO DE MENSAJES OFICIAL (CLOUD API)
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

// ---------------------------------------------------------------------------------
// 4. FUNCIONES DEL CRM (Usuarios, Historial, etc.)
// ---------------------------------------------------------------------------------
io.on('connection', (socket) => {
    socket.emit('whatsapp-ready'); 

    socket.on('request-chats', async () => { 
        try {
            const dbContacts = await sql`SELECT id, name, last_message, label, full_name, document_id, email, alt_phone, address, district, reference, customer_type, assigned_to, EXTRACT(EPOCH FROM updated_at) as unix_ts FROM contacts ORDER BY updated_at DESC LIMIT 15`; 
            
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
            let rawData = await sql`SELECT id, contact_id as from, body, is_mine, is_note, media_url, mime_type, ack, agent_name, EXTRACT(EPOCH FROM timestamp) as unix_ts FROM messages WHERE contact_id = ${chatId} ORDER BY timestamp ASC`; 
            let dbMessages = rawData.map(m => ({ id: m.id, from: m.from, body: m.body, isMine: m.is_mine === true || m.is_mine === 'true' || m.is_mine === 't', isNote: m.is_note === true, mediaUrl: m.media_url, mimeType: m.mime_type, ack: m.ack, agentName: m.agent_name, timestamp: new Date(m.unix_ts * 1000).toISOString() })); 
            socket.emit('load-history', { chatId, messages: dbMessages }); 
        } catch (error) {} 
    });

    socket.on('send-message', async (data) => { 
        try {
            const metaMessageId = await sendOfficialMessage(data.to, data.text); 
            if(metaMessageId) { 
                await sql`INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) VALUES (${metaMessageId}, ${data.to}, ${data.text}, true, NOW(), 1, ${data.agentName}) ON CONFLICT (id) DO UPDATE SET agent_name = ${data.agentName}`; 
                
                io.emit('whatsapp-message', { 
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
            const user = await sql`SELECT username, role FROM users WHERE username = ${data.username} AND password = ${data.password}`; 
            if (user.length > 0) socket.emit('login-success', { username: user[0].username, role: user[0].role }); 
            else socket.emit('login-error', 'Usuario o contraseña incorrectos'); 
        } catch (error) {} 
    });

    socket.on('get-users', async () => { 
        try {
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; 
            socket.emit('load-users', users); 
        } catch (error) {} 
    });

    socket.on('create-user', async (data) => { 
        try {
            await sql`INSERT INTO users (username, password, role) VALUES (${data.username}, ${data.password}, ${data.role})`; 
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; 
            io.emit('load-users', users); 
        } catch (error) { 
             socket.emit('user-error', 'El usuario ya existe.'); 
        }
    });

    socket.on('delete-user', async (id) => { 
        try {
            await sql`DELETE FROM users WHERE id = ${id}`; 
            const users = await sql`SELECT id, username, role FROM users ORDER BY id ASC`; 
            io.emit('load-users', users); 
        } catch (error) {} 
    });

    // 🌟 NUEVO EVENTO: Asignación Manual de Agentes
    socket.on('assign-agent', async (data) => {
        try {
            const agentToAssign = data.agentName === "" ? null : data.agentName; // Maneja la opción "Nadie"
            
            // 1. Guardar en la Base de Datos
            await sql`
                UPDATE contacts 
                SET assigned_to = ${agentToAssign} 
                WHERE id = ${data.chatId}
            `;
            
            // 2. Avisarle a todos los usuarios conectados (Frontend) para que la UI se actualice en vivo
            io.emit('agent-assigned', { 
                chatId: data.chatId, 
                agentName: agentToAssign 
            });
            
            console.log(`👤 Reasignación manual: Chat ${data.chatId} asignado a ${agentToAssign || 'Bandeja Global'}`);
        } catch (error) {
            console.error("❌ Error al asignar agente:", error);
        }
    });

});

server.listen(port, () => {
  console.log(`🚀 Servidor Ultraligero (Cloud API) corriendo en puerto ${port}`);
});
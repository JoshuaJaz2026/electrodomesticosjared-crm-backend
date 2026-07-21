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
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN; 

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

// 🤖 LA MEMORIA A CORTO PLAZO DEL BOT (State Machine)
let botStates = {}; 
let turnoActualIndex = 0; 

// --- ENDPOINT: RECEPCIÓN DE MENSAJES EN TIEMPO REAL ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  let body = req.body;

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

      // ---------------------------------------------------------
      // 🕵️‍♂️ EL FLUJO DEL CHATBOT DE PRE-CALIFICACIÓN
      // ---------------------------------------------------------

      // Buscamos las configuraciones de los textos en la base de datos
      const botSettingsDB = await sql`SELECT * FROM bot_settings LIMIT 1`;
      const botConfig = botSettingsDB[0] || {
          greeting_menu: "¡Hola! Bienvenido a Electrodomésticos Jared. Por favor, elige una opción:\n1️⃣ Comprar / Ventas\n2️⃣ Soporte Técnico\n3️⃣ Envíos",
          opt1_reply: "Has elegido Ventas.",
          opt2_reply: "Has elegido Soporte.",
          opt3_reply: "Has elegido Envíos.",
          opt4_reply: "Conectando con un asesor..."
      };

      let state = botStates[contactId] || { step: 'inicio' };
      let respuestaBot = null;
      let transferirAAsesor = false;

      // EL CLIENTE ESTÁ EN EL MENÚ PRINCIPAL
      if (state.step === 'inicio') {
          if (text === '1') {
              respuestaBot = "¡Excelente! Para brindarte una mejor atención y agilizar tu cotización, ¿me podrías indicar tu *Nombre Completo*?";
              botStates[contactId] = { step: 'pidiendo_nombre' };
          } else if (text === '2') {
              respuestaBot = botConfig.opt2_reply;
              transferirAAsesor = true;
          } else if (text === '3') {
              respuestaBot = botConfig.opt3_reply;
              transferirAAsesor = true;
          } else if (text === '4') {
              respuestaBot = botConfig.opt4_reply;
              transferirAAsesor = true;
          } else {
              // Si no eligió un número, le enviamos el menú de bienvenida
              respuestaBot = botConfig.greeting_menu;
          }
      } 
      // EL CLIENTE ESTÁ ESCRIBIENDO SU NOMBRE
      else if (state.step === 'pidiendo_nombre') {
          botStates[contactId].nombreCliente = text; // Guardamos el nombre en la memoria temporal
          respuestaBot = `Perfecto ${text}, ¿y cuál es tu *DNI o RUC*?`;
          botStates[contactId].step = 'pidiendo_dni';
      }
      // EL CLIENTE ESTÁ ESCRIBIENDO SU DNI
      else if (state.step === 'pidiendo_dni') {
          const nombreGuardado = botStates[contactId].nombreCliente;
          const dniGuardado = text;
          
          respuestaBot = `¡Gracias, ${nombreGuardado}! He registrado tu DNI (${dniGuardado}). Te estoy transfiriendo con uno de nuestros asesores de ventas para que te ayude con tu compra. 👨‍💻`;
          
          // ACTUALIZAMOS LA BASE DE DATOS (Ficha CRM) CON LOS DATOS OBTENIDOS
          await sql`
             UPDATE contacts 
             SET full_name = ${nombreGuardado}, document_id = ${dniGuardado} 
             WHERE id = ${contactId}
          `;
          
          // Avisamos al frontend que los datos cambiaron para que actualice el Panel Derecho
          io.emit('contact-info-updated', { 
             chatId: contactId, 
             fullName: nombreGuardado, 
             documentId: dniGuardado 
          });

          transferirAAsesor = true;
          delete botStates[contactId]; // Limpiamos la memoria porque ya terminó el flujo
      }

      // ---------------------------------------------------------
      // 🎰 ASIGNACIÓN DE AGENTES (ROUND-ROBIN)
      // ---------------------------------------------------------
      let clienteExistente = await sql`SELECT assigned_to FROM contacts WHERE id = ${contactId}`;
      let asesorAsignado = null;

      if (clienteExistente.length > 0 && clienteExistente[0].assigned_to) {
          asesorAsignado = clienteExistente[0].assigned_to;
      } else if (transferirAAsesor) {
          // Solo lanzamos la ruleta si el bot ya lo transfirió o no tiene dueño
          let asesores = await sql`SELECT username FROM users WHERE role = 'Agente' ORDER BY id ASC`;
          if (asesores.length > 0) {
              asesorAsignado = asesores[turnoActualIndex].username;
              turnoActualIndex++;
              if (turnoActualIndex >= asesores.length) turnoActualIndex = 0; 
              io.emit('agent-assigned', { chatId: contactId, agentName: asesorAsignado });
          }
      }

      // GUARDAMOS AL CLIENTE Y EL MENSAJE ENTRANTE
      await sql`
        INSERT INTO contacts (id, name, last_message, updated_at, assigned_to) 
        VALUES (${contactId}, ${pushName}, ${text}, NOW(), ${asesorAsignado}) 
        ON CONFLICT (id) DO UPDATE 
        SET last_message = ${text}, updated_at = NOW()
      `; 
      
      await sql`
        INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack) 
        VALUES (${messageId}, ${contactId}, ${text}, false, NOW(), 1) 
        ON CONFLICT (id) DO NOTHING
      `; 
      
      io.emit('whatsapp-message', { id: messageId, from: contactId, contactName: pushName, summaryText: text, body: text, mediaUrl: null, mimeType: null, ack: 1, timestamp: new Date(), isMine: false }); 

      // 🤖 SI EL BOT TIENE ALGO QUE DECIR, LO ENVÍA
      if (respuestaBot) {
          await sendOfficialMessage(contactId, respuestaBot);
          const botMessageId = "bot_" + Date.now();
          await sql`
            INSERT INTO messages (id, contact_id, body, is_mine, timestamp, ack, agent_name) 
            VALUES (${botMessageId}, ${contactId}, ${respuestaBot}, true, NOW(), 1, 'Chatbot')
          `;
          io.emit('whatsapp-message', { id: botMessageId, from: contactId, body: respuestaBot, timestamp: new Date(), isMine: true, agentName: 'Chatbot' });
      }

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

    // 🌟 EVENTO: Asignación Manual de Agentes
    socket.on('assign-agent', async (data) => {
        try {
            const agentToAssign = data.agentName === "" ? null : data.agentName;
            await sql`UPDATE contacts SET assigned_to = ${agentToAssign} WHERE id = ${data.chatId}`;
            io.emit('agent-assigned', { chatId: data.chatId, agentName: agentToAssign });
            console.log(`👤 Reasignación manual: Chat ${data.chatId} asignado a ${agentToAssign || 'Bandeja Global'}`);
        } catch (error) {
            console.error("❌ Error al asignar agente:", error);
        }
    });

    // 🌟 EVENTO: Obtener el directorio completo de clientes
    socket.on('get-all-contacts', async () => {
        try {
            const allContacts = await sql`
                SELECT id, name, full_name, document_id, customer_type, label, TO_CHAR(updated_at, 'DD/MM/YYYY HH24:MI') as last_seen 
                FROM contacts ORDER BY updated_at DESC
            `;
            socket.emit('load-all-contacts', allContacts);
        } catch (error) {
            console.error("❌ Error obteniendo directorio:", error);
        }
    });

});

server.listen(port, () => {
  console.log(`🚀 Servidor Ultraligero (Cloud API) corriendo en puerto ${port}`);
});
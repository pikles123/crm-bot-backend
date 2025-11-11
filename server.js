// server.js

// --- IMPORTS ---
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";

dotenv.config();

console.log("✅ Verificando variables de entorno de Twilio...");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- TWILIO CLIENT ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- ESTADO TEMPORAL DE CONVERSACIONES EN MEMORIA ---
const conversations = {}; // key = "whatsapp:+569..." -> { step: number, data: {...} }

// --- HELPERS ---
function parseMondayPhoneColumn(col) {
  try {
    if (!col) return null;
    if (col.value) {
      const parsed = typeof col.value === "string" ? JSON.parse(col.value) : col.value;
      if (parsed?.phone) return parsed.phone;
    }
    if (col.text) return col.text;
    return null;
  } catch (e) {
    return col.text || null;
  }
}

// --- FUNCION CORREGIDA PARA ENVIAR MENSAJES ---
async function sendWhatsAppMessage(to, body) {
  try {
    if (!process.env.TWILIO_PHONE_NUMBER) {
      throw new Error("TWILIO_PHONE_NUMBER no está definido en variables de entorno.");
    }
    if (!to || !body) {
      throw new Error(`Parámetros inválidos en sendWhatsAppMessage: to=${to}, body=${body}`);
    }

    console.log(`📤 Enviando mensaje a ${to}: "${body}"`);

    const msg = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, // ejemplo: whatsapp:+14155238886
      to,
      body,
    });

    console.log(`✅ Mensaje enviado correctamente (SID: ${msg.sid})`);
  } catch (err) {
    console.error("❌ Error enviando mensaje WhatsApp:", err.message);
  }
}

// --- RUTA DE TEST ---
app.get("/", (req, res) => {
  res.send("✅ Servidor funcionando. Webhooks activos en /monday-webhook y /whatsapp-webhook.");
});

// --- WEBHOOK DESDE MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Monday:", JSON.stringify(req.body, null, 2));

  if (req.body.challenge) {
    return res.status(200).send({ challenge: req.body.challenge });
  }

  res.status(200).send("OK");

  try {
    const event = req.body?.event;
    if (!event) return;

    const pulseId = event.pulseId;
    if (!pulseId) return;

    // --- Consultar a Monday API ---
    const query = `
      query {
        items (ids: ${pulseId}) {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    `;
    const mondayResp = await axios.post(
      "https://api.monday.com/v2",
      { query },
      { headers: { Authorization: process.env.MONDAY_API_TOKEN } }
    );

    const item = mondayResp.data?.data?.items?.[0];
    if (!item) return;

    const columns = (item.column_values || []).reduce((acc, c) => {
      acc[c.id] = c;
      return acc;
    }, {});

    console.log("📦 Column values del item:", Object.keys(columns));

    const nombre_cliente = item.name || "Cliente";
    const telefonoRaw =
      parseMondayPhoneColumn(columns["phone_mkxkb8na"]) ||
      parseMondayPhoneColumn(columns["telefono"]) ||
      parseMondayPhoneColumn(columns["text_mkxk37gb"]) ||
      null;

    console.log("📞 Teléfono (raw):", telefonoRaw);
    if (!telefonoRaw) return;

    // --- Normalizar teléfono ---
    let telefonoClean = telefonoRaw.replace(/\s+/g, "").replace(/[()\-\.]/g, "");
    if (!telefonoClean.startsWith("+")) {
      const t = telefonoClean;
      if (/^0?9\d{7,}$/.test(t)) {
        telefonoClean = t.replace(/^0/, "");
        telefonoClean = `+56${telefonoClean}`;
      } else {
        telefonoClean = `+${telefonoClean}`;
      }
    }

    const to = `whatsapp:${telefonoClean}`;

    // --- Iniciar conversación ---
    conversations[to] = { step: 1, data: { nombre_cliente } };

    await sendWhatsAppMessage(
      to,
      `Hola ${nombre_cliente}! 👋 
Soy MarIA, tu asistente virtual que te apoyará con la gestión de tu crédito hipotecario. 
Primero necesito hacerte unas preguntas.`
    );

    await sendWhatsAppMessage(to, "1️⃣ ¿Podrías confirmarme tu RUT?");

    console.log(`✅ Mensajes iniciales enviados a ${to}`);
  } catch (error) {
    console.error("❌ Error procesando webhook de Monday:", error?.response?.data || error.message || error);
  }
});

// --- WEBHOOK DESDE TWILIO (MENSAJES ENTRANTES) ---
app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body?.From;
  const body = (req.body?.Body || "").trim();
  console.log(`💬 Mensaje entrante desde Twilio: from=${from} body="${body}"`);

  if (!from) return;

  let convo = conversations[from];
  if (!convo) {
    conversations[from] = { step: 1, data: {} };
    convo = conversations[from];
  }

  try {
    const { step, data } = convo;

    switch (step) {
      case 1:
        data.rut = body;
        convo.step = 2;
        await sendWhatsAppMessage(from, "2️⃣ ¿Qué tipo de trabajador eres?\n1) Dependiente  2) Independiente  3) Socio Empresa");
        break;

      case 2: {
        const map = { "1": "Dependiente", "2": "Independiente", "3": "Socio Empresa" };
        data.tipo_trabajador = map[body] || body;
        convo.step = 3;
        await sendWhatsAppMessage(from, "3️⃣ ¿Es tu primera vivienda? (Sí / No)");
        break;
      }

      case 3:
        data.primera_vivienda = /^s/i.test(body) ? "Sí" : "No";
        convo.step = 4;
        await sendWhatsAppMessage(from, "4️⃣ ¿Cuál es el precio de compra de tu propiedad? (en UF)");
        break;

      case 4:
        data.precio_uf = body;
        convo.step = 5;
        await sendWhatsAppMessage(from, "5️⃣ ¿Es una casa o un departamento?");
        break;

      case 5:
        data.tipo_vivienda = /casa/i.test(body) ? "Casa" : "Departamento";
        convo.step = 6;

        let docsText = "";
        const tipo = (data.tipo_trabajador || "").toLowerCase();

        if (tipo.includes("depend")) {
          docsText = `📄 Documentos requeridos (Dependiente):
- 3 últimas liquidaciones de sueldo
- Certificado de antigüedad laboral
- Cotizaciones AFP (últimos 12 meses)`;
        } else if (tipo.includes("indepen")) {
          docsText = `📄 Documentos requeridos (Independiente):
- 2 últimas declaraciones de renta
- Comprobantes de IVA (últimos 6 meses)
- Certificado de inicio de actividades / Boletas`;
        } else if (tipo.includes("socio")) {
          docsText = `📄 Documentos requeridos (Socio Empresa):
- Declaraciones de renta empresa y personal
- Escritura de constitución
- Certificado de vigencia de sociedad`;
        } else {
          docsText = `Por favor indícanos tu tipo de trabajador (Dependiente / Independiente / Socio Empresa).`;
        }

        await sendWhatsAppMessage(from, `Ahora necesito que me envíes los siguientes documentos:\n${docsText}`);
        break;

      case 6:
        convo.step = 7;
        await sendWhatsAppMessage(from, `✅ Gracias, todos los documentos fueron recibidos correctamente. Iniciaremos la evaluación crediticia. ¡Nos vemos! 👋`);
        delete conversations[from];
        break;

      default:
        await sendWhatsAppMessage(from, "Gracias! Si necesitas algo más, escribe 'ayuda'.");
        break;
    }

    console.log("🧾 Conversación actual:", conversations[from]);
  } catch (err) {
    console.error("❌ Error en webhook de Twilio:", err.message);
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

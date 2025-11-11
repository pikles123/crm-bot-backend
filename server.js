// server.js

// --- IMPORTS ---
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";

dotenv.config();

console.log("✅ Verificando variables de entorno...");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID || "(no definido)");
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "(definido)" : "(no definido)");
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER || "(no definido)");
console.log("MONDAY_API_TOKEN:", process.env.MONDAY_API_TOKEN ? "(definido)" : "(no definido)");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- TWILIO CLIENT ---
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error("❌ Faltan credenciales de Twilio. Configura TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN en tu .env");
}
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- CONVERSACIONES EN MEMORIA ---
const conversations = {}; // key = "whatsapp:+569..." -> { step: number, data: {...} }

// --- HELPER: PARSEAR COLUMNA DE TELÉFONO DE MONDAY ---
function parseMondayPhoneColumn(col) {
  try {
    if (!col) return null;

    // Si es JSON dentro de "value"
    if (col.value) {
      const parsed = typeof col.value === "string" ? JSON.parse(col.value) : col.value;
      if (parsed?.phone) return parsed.phone;
    }

    // Si tiene texto plano
    if (col.text && typeof col.text === "string" && col.text.trim() !== "") {
      return col.text.trim();
    }

    return null;
  } catch {
    return col?.text || null;
  }
}

// --- FUNCIÓN PARA ENVIAR MENSAJE WHATSAPP ---
async function sendWhatsAppMessage(to, body) {
  try {
    if (!process.env.TWILIO_PHONE_NUMBER) {
      throw new Error("TWILIO_PHONE_NUMBER no está definido.");
    }
    if (!to || !body) {
      throw new Error(`Parámetros inválidos: to=${to}, body=${body}`);
    }

    console.log(`📤 Enviando WhatsApp a ${to}: "${body}"`);

    const msg = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, // ejemplo: whatsapp:+14155238886
      to,
      body,
    });

    console.log(`✅ Mensaje enviado correctamente (SID: ${msg.sid})`);
  } catch (err) {
    console.error("❌ Error enviando WhatsApp:", err.message);
  }
}

// --- RUTA TEST ---
app.get("/", (req, res) => {
  res.send("✅ Servidor funcionando. Webhooks activos en /monday-webhook y /whatsapp-webhook.");
});

// --- WEBHOOK DESDE MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Monday:", JSON.stringify(req.body, null, 2));

  // Challenge de verificación
  if (req.body.challenge) {
    return res.status(200).send({ challenge: req.body.challenge });
  }

  res.status(200).send("OK");

  try {
    const event = req.body?.event;
    if (!event) throw new Error("No se recibió 'event' desde Monday.");

    const pulseId = event.pulseId;
    if (!pulseId) throw new Error("No se recibió 'pulseId' desde Monday.");

    // --- Consultar item a Monday ---
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
    if (!item) throw new Error("No se encontró el item en Monday.");

    const columns = (item.column_values || []).reduce((acc, c) => {
      acc[c.id] = c;
      return acc;
    }, {});

    console.log("📦 Columnas del item:", Object.keys(columns));

    const nombre_cliente = item.name || "Cliente";
    const telefonoRaw =
      parseMondayPhoneColumn(columns["phone_mkxkb8na"]) ||
      parseMondayPhoneColumn(columns["telefono"]) ||
      parseMondayPhoneColumn(columns["text_mkxk37gb"]) ||
      null;

    console.log("📞 Teléfono detectado:", telefonoRaw);
    if (!telefonoRaw) throw new Error("No se encontró número de teléfono en Monday.");

    // --- Normalizar teléfono ---
    let telefonoClean = telefonoRaw.replace(/\s+/g, "").replace(/[()\-\.]/g, "");
    if (!telefonoClean.startsWith("+")) {
      if (/^0?9\d{7,}$/.test(telefonoClean)) {
        telefonoClean = telefonoClean.replace(/^0/, "");
        telefonoClean = `+56${telefonoClean}`;
      } else {
        telefonoClean = `+${telefonoClean}`;
      }
    }

    const to = `whatsapp:${telefonoClean}`;
    console.log("📱 Enviando mensajes al número normalizado:", to);

    // --- Guardar conversación ---
    conversations[to] = { step: 1, data: { nombre_cliente } };

    // --- Mensajes iniciales ---
    await sendWhatsAppMessage(
      to,
      `Hola ${nombre_cliente}! 👋 
Soy MarIA, tu asistente virtual de Uniflou. Te apoyaré en la gestión de tu Crédito Hipotecario.`
    );

    await sendWhatsAppMessage(to, "1️⃣ Primero, necesito hacerte un par de preguntas. ¿Podrías confirmarme tu RUT?");
  } catch (error) {
    console.error("❌ Error procesando webhook de Monday:", error.message);
  }
});

// --- WEBHOOK DESDE TWILIO (MENSAJES ENTRANTES) ---
app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body?.From;
  const body = (req.body?.Body || "").trim();

  console.log(`💬 Mensaje entrante: from=${from}, body="${body}"`);
  if (!from) return;

  if (!conversations[from]) {
    conversations[from] = { step: 1, data: {} };
  }

  const convo = conversations[from];

  try {
    switch (convo.step) {
      case 1:
        convo.data.rut = body;
        convo.step = 2;
        await sendWhatsAppMessage(from, "2️⃣ ¿Qué tipo de trabajador eres?\n1) Dependiente  2) Independiente  3) Socio Empresa");
        break;

      case 2: {
        const map = { "1": "Dependiente", "2": "Independiente", "3": "Socio Empresa" };
        convo.data.tipo_trabajador = map[body] || body;
        convo.step = 3;
        await sendWhatsAppMessage(from, "3️⃣ ¿Es tu primera vivienda? (Sí / No)");
        break;
      }

      case 3:
        convo.data.primera_vivienda = /^s/i.test(body) ? "Sí" : "No";
        convo.step = 4;
        await sendWhatsAppMessage(from, "4️⃣ ¿Cuál es el precio de compra de tu propiedad? (en UF)");
        break;

      case 4:
        convo.data.precio_uf = body;
        convo.step = 5;
        await sendWhatsAppMessage(from, "5️⃣ ¿Es una casa o un departamento?");
        break;

      case 5:
        convo.data.tipo_vivienda = /casa/i.test(body) ? "Casa" : "Departamento";
        convo.step = 6;

        const tipo = (convo.data.tipo_trabajador || "").toLowerCase();
        let docsText = "";

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
          docsText = "Por favor indícanos tu tipo de trabajador.";
        }

        await sendWhatsAppMessage(from, `Ahora necesito que me envíes los siguientes documentos:\n${docsText}`);
        break;

      case 6:
        convo.step = 7;
        await sendWhatsAppMessage(
          from,
          "✅ Gracias, todos los documentos fueron recibidos correctamente. Iniciaremos la evaluación crediticia. ¡Nos vemos! 👋"
        );
        delete conversations[from];
        break;

      default:
        await sendWhatsAppMessage(from, "Gracias! Si necesitas algo más, escribe 'ayuda'.");
        break;
    }

    console.log("🧾 Estado actual conversación:", conversations[from]);
  } catch (err) {
    console.error("❌ Error en webhook de Twilio:", err.message);
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

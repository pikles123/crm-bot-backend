// --- IMPORTS ---
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

dotenv.config();

console.log("✅ Verificando variables de entorno...");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER);
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "✅ OK" : "❌ FALTA");

// --- APP EXPRESS ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- CLIENTES ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- ESTADO DE CONVERSACIONES ---
const conversations = {}; // key = "whatsapp:+569..." → { history: [{role, content}], nombre_cliente }

// --- TEMPLATE SID ---
const WHATSAPP_TEMPLATE_SID = "HX66fce12d7c4708fbe29bf356bc539a53"; // reemplazar si cambia

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

// --- FUNCION: Enviar template ---
async function sendWhatsAppTemplate(to, nombre_cliente) {
  try {
    const msg = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      contentSid: WHATSAPP_TEMPLATE_SID,
      contentVariables: JSON.stringify({ "1": nombre_cliente || "cliente" }),
    });
    console.log(`✅ Template enviado (SID: ${msg.sid})`);
  } catch (err) {
    console.error("❌ Error enviando template:", err.message);
  }
}

// --- FUNCION: Enviar mensaje ---
async function sendWhatsAppMessage(to, body) {
  try {
    const msg = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body,
    });
    console.log(`✅ Enviado a ${to}: "${body}"`);
  } catch (err) {
    console.error("❌ Error enviando WhatsApp:", err.message);
  }
}

// --- FUNCION: Obtener respuesta desde OpenAI ---
async function getAIResponse(history) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `Eres MarIA, asistente virtual de Uniflou, experta en créditos hipotecarios en Chile.
Hablas con tono amable, claro y profesional. 
Puedes guiar a los clientes con documentos, requisitos y pasos del crédito hipotecario. 
Si el cliente envía archivos, puedes pedirle que confirme qué documento es.`,
        },
        ...history,
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("❌ Error generando respuesta de IA:", error.message);
    return "Lo siento, tuve un problema al procesar tu mensaje. ¿Podrías repetirlo?";
  }
}

// --- RUTA TEST ---
app.get("/", (req, res) => {
  res.send("✅ Servidor funcionando con Twilio + OpenAI.");
});

// --- WEBHOOK MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  res.status(200).send("OK");
  try {
    const event = req.body?.event;
    if (!event) throw new Error("No se recibió 'event' desde Monday.");
    const pulseId = event.pulseId;

    // --- Consultar datos en Monday ---
    const query = `
      query {
        items (ids: ${pulseId}) {
          id
          name
          column_values { id text value }
        }
      }
    `;
    const mondayResp = await axios.post(
      "https://api.monday.com/v2",
      { query },
      { headers: { Authorization: process.env.MONDAY_API_TOKEN } }
    );

    const item = mondayResp.data?.data?.items?.[0];
    if (!item) throw new Error("Item no encontrado en Monday.");

    const columns = (item.column_values || []).reduce((acc, c) => {
      acc[c.id] = c;
      return acc;
    }, {});

    const nombre_cliente = item.name || "Cliente";
    const telefonoRaw =
      parseMondayPhoneColumn(columns["phone_mkxkb8na"]) ||
      parseMondayPhoneColumn(columns["telefono"]) ||
      parseMondayPhoneColumn(columns["text_mkxk37gb"]) ||
      null;

    if (!telefonoRaw) throw new Error("No se encontró teléfono en Monday.");

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
    console.log("📱 Enviando template inicial a:", to);

    conversations[to] = { history: [], nombre_cliente };
    await sendWhatsAppTemplate(to, nombre_cliente);
  } catch (err) {
    console.error("❌ Error procesando webhook de Monday:", err.message);
  }
});

// --- WEBHOOK TWILIO ---
app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body?.From;
  const body = (req.body?.Body || "").trim();
  if (!from || !body) return;

  console.log(`💬 Mensaje entrante de ${from}: "${body}"`);

  if (!conversations[from]) conversations[from] = { history: [] };

  // --- Guardar mensaje del usuario ---
  conversations[from].history.push({ role: "user", content: body });

  // --- Obtener respuesta IA ---
  const reply = await getAIResponse(conversations[from].history);

  // --- Guardar respuesta del asistente ---
  conversations[from].history.push({ role: "assistant", content: reply });

  // --- Enviar por WhatsApp ---
  await sendWhatsAppMessage(from, reply);
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));

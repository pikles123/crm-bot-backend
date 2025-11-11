// server.js
// --- IMPORTS ---
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";

dotenv.config();

console.log("✅ Variables Twilio:");
console.log("SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("AUTH TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "Cargado ✅" : "No cargado ❌");
console.log("PHONE:", process.env.TWILIO_PHONE_NUMBER);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- TWILIO CLIENT ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- ESTADO TEMPORAL DE CONVERSACIONES EN MEMORIA ---
const conversations = {}; // key = "whatsapp:+569..." -> { step: number, data: {...} }

// --- HELPERS ---
function parseMondayPhoneColumn(col) {
  // col.value usually es un JSON-string en columnas tipo Phone en Monday
  try {
    if (!col) return null;
    if (col.value) {
      const parsed = typeof col.value === "string" ? JSON.parse(col.value) : col.value;
      // Monday phone column may include .phone
      if (parsed?.phone) return parsed.phone;
    }
    // fallback a text
    if (col.text) return col.text;
    return null;
  } catch (e) {
    // si no se pudo parsear
    return col.text || null;
  }
}

async function sendWhatsAppMessage(to, body) {
  return client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body,
  });
}

// --- RUTA RAIZ (debug) ---
app.get("/", (req, res) => {
  res.send("✅ Servidor funcionando. /monday-webhook y /whatsapp-webhook activos.");
});

// --- WEBHOOK DESDE MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Monday:", JSON.stringify(req.body, null, 2));

  // Responder challenge si Monday lo envía (verificación)
  if (req.body.challenge) {
    console.log("🔹 Respondiendo challenge de Monday...");
    return res.status(200).send({ challenge: req.body.challenge });
  }

  // Responder rápido para que Monday no marque error
  res.status(200).send("OK");

  try {
    const event = req.body?.event;
    if (!event) {
      console.log("⚠️ Evento vacío recibido.");
      return;
    }

    // Si webhook no trae pulseId, no hay cómo consultar el item
    const pulseId = event.pulseId || event.pulseId;
    if (!pulseId) {
      console.log("⚠️ No se encontró pulseId en el evento. event:", JSON.stringify(event));
      return;
    }

    // CONSULTA GraphQL a Monday para obtener el item completo (nombre + columnas)
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
    if (!item) {
      console.log("⚠️ No se obtuvo item desde Monday para id:", pulseId);
      return;
    }

    // Convertir column_values a objeto por id
    const columns = (item.column_values || []).reduce((acc, c) => {
      acc[c.id] = c;
      return acc;
    }, {});

    console.log("📦 Column values del item:", Object.keys(columns));

    // EXTRAER DATOS IMPORTANTES
    const nombre_cliente = item.name || "Cliente";
    // phone_mkxkb8na es la columna de teléfono que indicaste
    const telefonoRaw = parseMondayPhoneColumn(columns["phone_mkxkb8na"]) ||
                       parseMondayPhoneColumn(columns["telefono"]) ||
                       parseMondayPhoneColumn(columns["text_mkxk37gb"]) ||
                       null;

    console.log("📞 Teléfono (raw):", telefonoRaw);

    if (!telefonoRaw) {
      console.log("⚠️ No hay teléfono en el item. No se iniciará conversación.");
      return;
    }

    // Normalizar teléfono a formato E.164 con +
    let telefonoClean = telefonoRaw.replace(/\s+/g, "").replace(/[()\-\.]/g, "");
    // si empieza con 0 local (ej: 09...) y no tiene +, asumir Chile? (NO lo forzamos automáticamente aquí)
    if (!telefonoClean.startsWith("+")) {
      // si comienza con '9' o '09' asumo Chile +56
      const t = telefonoClean;
      if (/^0?9\d{7,}$/.test(t)) {
        // remove leading 0 if exists and prepend +56
        telefonoClean = t.replace(/^0/, "");
        telefonoClean = `+56${telefonoClean}`;
      } else {
        // si no queda en formato claro, simplemente intentar añadiendo +
        telefonoClean = `+${telefonoClean}`;
      }
    }

    const to = `whatsapp:${telefonoClean.replace(/\D/g, "")}`; // twilio espera whatsapp:+569...

    // Guardar conversación en memoria con key = from (Twilio 'From' es 'whatsapp:+...'), guardamos same format
    const fromKey = `whatsapp:${telefonoClean.replace(/\D/g, "")}`;
    conversations[fromKey] = { step: 1, data: { nombre_cliente } };

    // MENSAJES INICIALES
    await sendWhatsAppMessage(fromKey, `Hola ${nombre_cliente}! 👋 
Soy MarIA, tu asistente virtual que te va a apoyar con la gestión de tu crédito hipotecario. 
Lo primero que vamos a hacer es contestar unas preguntas.`);

    await sendWhatsAppMessage(fromKey, "1️⃣ Me puedes confirmar tu RUT?");

    console.log(`✅ Mensajes iniciales enviados a ${fromKey}`);

  } catch (error) {
    console.error("❌ Error procesando webhook de Monday:", error?.response?.data || error.message || error);
  }
});

// --- WEBHOOK DESDE TWILIO (INCOMING MESSAGES) ---
// Configurar en Twilio la URL: https://tuapp.onrender.com/whatsapp-webhook (POST)
app.post("/whatsapp-webhook", async (req, res) => {
  // Responder rápido a Twilio
  res.status(200).send("OK");

  const from = req.body?.From; // ej: "whatsapp:+569XXXXXXXX"
  const body = (req.body?.Body || "").trim();
  console.log(`💬 Mensaje entrante desde Twilio: from=${from} body="${body}"`);

  if (!from) {
    console.log("⚠️ Request de Twilio sin From");
    return;
  }

  // Asegurar que exista sesión
  let convo = conversations[from];
  if (!convo) {
    // Si no hay conversación previa, inicializar (esto evita bloquear al usuario)
    conversations[from] = { step: 1, data: {} };
    convo = conversations[from];
  }

  try {
    const { step, data } = convo;

    switch (step) {
      // 1 => esperamos RUT
      case 1:
        data.rut = body;
        convo.step = 2;
        await sendWhatsAppMessage(from, "2️⃣ ¿Qué tipo de trabajador eres?\nResponde: 1) Dependiente  2) Independiente  3) Socio Empresa");
        break;

      // 2 => tipo de trabajador
      case 2: {
        const map = { "1": "Dependiente", "2": "Independiente", "3": "Socio Empresa" };
        data.tipo_trabajador = map[body] || body;
        convo.step = 3;
        await sendWhatsAppMessage(from, "3️⃣ ¿Es tu primera vivienda? (Sí / No)");
        break;
      }

      // 3 => primera vivienda
      case 3:
        data.primera_vivienda = (/^s/i).test(body) ? "Sí" : "No";
        convo.step = 4;
        await sendWhatsAppMessage(from, "4️⃣ ¿Cuál es el precio de compra de tu propiedad? (indica valor en UF)");
        break;

      // 4 => precio UF
      case 4:
        data.precio_uf = body;
        convo.step = 5;
        await sendWhatsAppMessage(from, "5️⃣ ¿Es una casa o un departamento?");
        break;

      // 5 => tipo vivienda
      case 5:
        data.tipo_vivienda = (/casa/i).test(body) ? "Casa" : "Departamento";
        convo.step = 6;

        // Enviar documentos según tipo de trabajador
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
          docsText = `Por favor indícanos tu tipo de trabajador (Dependiente / Independiente / Socio Empresa) para enviarte el listado correcto.`;
        }

        await sendWhatsAppMessage(from, `Ahora, vamos a necesitar que me envíes el siguiente listado de documentos:\n${docsText}`);
        break;

      // 6 => espera recepción de documentos (aquí asumimos que usuario enviará archivos; para este demo, cerramos)
      case 6:
        // Aquí podrías implementar verificación de attachments en req.body (Twilio entrega MediaUrlX)
        // Para simplificar asumimos que recibieron y se revisaron:
        convo.step = 7;
        await sendWhatsAppMessage(from, `✅ Muchas gracias, todos los documentos están revisados y estaríamos ok para comenzar con el proceso de evaluación crediticia. Estaremos en contacto por mail. ¡Nos vemos! 👋`);
        // opcional: actualizar Monday con estado final mediante API
        delete conversations[from]; // limpiar sesión
        break;

      default:
        await sendWhatsAppMessage(from, "Gracias! Si necesitas algo más, escribe 'ayuda'.");
        break;
    }

    console.log("🧾 Conversación actual:", conversations[from]);
  } catch (err) {
    console.error("❌ Error en webhook de Twilio:", err?.message || err);
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});


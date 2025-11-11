// --- IMPORTS ---
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- TWILIO CLIENT ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- ESTADO TEMPORAL DE CONVERSACIONES ---
const conversations = {}; // { telefono: { step: 1, data: {} } }

// --- WEBHOOK DESDE MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Monday:", req.body);

  // Paso 1: Challenge de conexión
  if (req.body.challenge) {
    console.log("🔹 Respondiendo challenge de Monday...");
    return res.status(200).send({ challenge: req.body.challenge });
  }

  // Paso 2: Confirmar recepción normal del webhook
  res.status(200).send("OK");

  try {
    const event = req.body?.event || {};
    const itemId = event?.pulseId;
    const boardId = event?.boardId;

    if (!itemId || !boardId) {
      console.log("⚠️ No se encontraron itemId o boardId en el webhook");
      return;
    }

    // 1️⃣ Consultar datos del item en Monday para obtener la columna 'telefono'
    const mondayResponse = await axios.post(
      "https://api.monday.com/v2",
      {
        query: `
          query {
            items(ids: [${itemId}]) {
              name
              column_values {
                id
                text
              }
            }
          }
        `,
      },
      {
        headers: {
          Authorization: process.env.MONDAY_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const mondayItem = mondayResponse.data.data.items[0];
    const nombre_cliente = mondayItem.name || "Cliente";

    // 🔍 Buscar la columna con id = "text_mkxk37gb"
    const telefonoColumn = mondayItem.column_values.find(
      (col) => col.id === "text_mkxk37gb"
    );
    const telefono = telefonoColumn?.text?.trim();

    if (!telefono) {
      console.log("⚠️ No hay teléfono disponible, no se puede iniciar conversación.");
      return;
    }

    const telefonoLimpio = telefono.replace(/\D/g, "");
    const to = `whatsapp:${telefonoLimpio}`;

    conversations[to] = { step: 1, data: { nombre_cliente } };

    // ✅ Mensaje inicial
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to,
      body: `Hola ${nombre_cliente}! 👋 
Soy MarIA, tu asistente virtual que te va a apoyar con la gestión de tu crédito hipotecario. 
Lo primero que vamos a hacer es contestar unas preguntas.`,
    });

    // ➡️ Primera pregunta
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to,
      body: `1️⃣ Me puedes confirmar tu RUT?`,
    });

    console.log(`✅ Conversación iniciada con ${telefono}`);

  } catch (err) {
    console.error("❌ Error procesando webhook de Monday:", err.message);
  }
});

// --- WEBHOOK DESDE TWILIO (RESPUESTAS DEL CLIENTE) ---
app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body.From;
  const message = req.body.Body?.trim();
  const conversation = conversations[from];

  if (!conversation) {
    console.log("⚠️ No hay conversación activa para:", from);
    return;
  }

  const { step, data } = conversation;

  switch (step) {
    case 1:
      data.rut = message;
      conversation.step = 2;
      await sendMessage(from, "2️⃣ Qué tipo de trabajador eres?\n1. Dependiente\n2. Independiente\n3. Socio Empresa");
      break;

    case 2:
      const tipoMap = { "1": "Dependiente", "2": "Independiente", "3": "Socio Empresa" };
      data.tipo_trabajador = tipoMap[message] || message;
      conversation.step = 3;
      await sendMessage(from, "3️⃣ ¿Es tu primera vivienda? (Sí / No)");
      break;

    case 3:
      data.primera_vivienda = message.toLowerCase().includes("sí") ? "Sí" : "No";
      conversation.step = 4;
      await sendMessage(from, "4️⃣ ¿Cuál es el precio de compra de tu propiedad? (en UF)");
      break;

    case 4:
      data.precio_uf = message;
      conversation.step = 5;
      await sendMessage(from, "5️⃣ ¿Es una casa o un departamento?");
      break;

    case 5:
      data.tipo_vivienda = message.toLowerCase().includes("casa") ? "Casa" : "Departamento";
      conversation.step = 6;

      // 📄 Documentos según tipo de trabajador
      let docs = "";
      switch (data.tipo_trabajador.toLowerCase()) {
        case "dependiente":
          docs = `
📄 Documentos requeridos (Dependiente):
- 3 últimas liquidaciones de sueldo
- Certificado de antigüedad laboral
- Cotizaciones AFP (últimos 12 meses)
`;
          break;
        case "independiente":
          docs = `
📄 Documentos requeridos (Independiente):
- 2 últimas declaraciones de renta
- IVA (últimos 6 meses)
- Certificado de inicio de actividades
`;
          break;
        case "socio empresa":
          docs = `
📄 Documentos requeridos (Socio Empresa):
- Declaraciones de renta empresa y personal
- Escritura de constitución
- Certificado de vigencia de sociedad
`;
          break;
        default:
          docs = "Por favor, indícanos tu tipo de trabajador para poder enviar el listado correcto.";
      }

      await sendMessage(from, `Ahora, vamos a necesitar que me puedas enviar el siguiente listado de documentos:\n${docs}`);
      break;

    case 6:
      conversation.step = 7;
      await sendMessage(from, `✅ Muchas gracias, todos los documentos están revisados y estaríamos ok para comenzar con el proceso de evaluación crediticia. Estaremos en contacto por mail. Nos vemos! 👋`);
      delete conversations[from];
      break;

    default:
      await sendMessage(from, "Gracias! Ya completamos el proceso 🙌");
      break;
  }
});

// --- FUNCIÓN AUXILIAR PARA ENVIAR MENSAJES ---
async function sendMessage(to, body) {
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body,
  });
}

// --- HOME ---
app.get("/", (req, res) => {
  res.send("✅ Servidor funcionando correctamente. Ruta raíz activa.");
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Estado temporal de conversaciones ---
const conversations = {}; // { telefono: { step: 1, data: {} } }

// --- Endpoint para recibir webhooks de Monday ---
app.post("/monday-webhook", async (req, res) => {
  res.status(200).send("OK");
  const event = req.body.event || {};
  const columns = event.columnValues || {};

  const nombre_cliente = columns.nombre_cliente?.text || "Cliente";
  const telefono = columns.telefono?.text || null;

  if (!telefono) return console.log("⚠️ No hay teléfono para contacto inicial.");

  const to = `whatsapp:${telefono.replace(/\D/g, "")}`;
  conversations[to] = { step: 1, data: { nombre_cliente } };

  // Primer mensaje
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body: `Hola ${nombre_cliente}! 👋 
Soy MarIA, tu asistente virtual que te va a apoyar con la gestión de tu crédito hipotecario. 
Lo primero que vamos a hacer es contestar unas preguntas.`,
  });

  // Segundo mensaje (pregunta 1)
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body: `1️⃣ Me puedes confirmar tu RUT?`,
  });
});

// --- Webhook para recibir mensajes desde Twilio ---
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
    // Pregunta 1 - RUT
    case 1:
      data.rut = message;
      conversation.step = 2;
      await sendMessage(from, "2️⃣ Qué tipo de trabajador eres?\n1. Dependiente\n2. Independiente\n3. Socio Empresa");
      break;

    // Pregunta 2 - Tipo de trabajador
    case 2:
      const tipoMap = { "1": "Dependiente", "2": "Independiente", "3": "Socio Empresa" };
      data.tipo_trabajador = tipoMap[message] || message;
      conversation.step = 3;
      await sendMessage(from, "3️⃣ ¿Es tu primera vivienda? (Sí / No)");
      break;

    // Pregunta 3 - Primera vivienda
    case 3:
      data.primera_vivienda = message.toLowerCase().includes("sí") ? "Sí" : "No";
      conversation.step = 4;
      await sendMessage(from, "4️⃣ ¿Cuál es el precio de compra de tu propiedad? (en UF)");
      break;

    // Pregunta 4 - Precio de compra
    case 4:
      data.precio_uf = message;
      conversation.step = 5;
      await sendMessage(from, "5️⃣ ¿Es una casa o un departamento?");
      break;

    // Pregunta 5 - Tipo de vivienda
    case 5:
      data.tipo_vivienda = message.toLowerCase().includes("casa") ? "Casa" : "Departamento";
      conversation.step = 6;

      // Enviar lista de documentos según tipo de trabajador
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

    // Revisión final (después de que envíe documentos)
    case 6:
      conversation.step = 7;
      await sendMessage(from, `✅ Muchas gracias, todos los documentos están revisados y estaríamos ok para comenzar con el proceso de evaluación crediticia. Estaremos en contacto por mail. Nos vemos! 👋`);
      delete conversations[from]; // limpiar sesión
      break;

    default:
      await sendMessage(from, "Gracias! Ya completamos el proceso 🙌");
      break;
  }
});

// --- Función auxiliar para enviar mensajes ---
async function sendMessage(to, body) {
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body,
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));


// --- Iniciar servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

// server.js — MarIA (v2 flujo completo con IA y Twilio)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const conversations = {};
const WHATSAPP_TEMPLATE_SID = "HX66fce12d7c4708fbe29bf356bc539a53"; // reemplaza por tu SID real

// --- HELPERS ---
const sendWhatsAppMessage = async (to, body) => {
  try {
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body,
    });
    console.log(`✅ Mensaje enviado a ${to}: ${body}`);
  } catch (e) {
    console.error("❌ Error enviando mensaje:", e.message);
  }
};

const sendWhatsAppTemplate = async (to, nombre_cliente) => {
  try {
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      contentSid: WHATSAPP_TEMPLATE_SID,
      contentVariables: JSON.stringify({ "1": nombre_cliente || "cliente" }),
    });
    console.log(`✅ Template enviado a ${to}`);
  } catch (e) {
    console.error("❌ Error enviando template:", e.message);
  }
};

// --- IA NATURAL ---
const askAI = async (history) => {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres MarIA, la asistente virtual de Uniflou.
Tu tarea es acompañar al cliente en su solicitud de Crédito Hipotecario.
Responde de forma clara, empática y profesional.
Nunca cambies el orden del flujo ni las preguntas, pero puedes ser amable y aclarar dudas.`,
        },
        ...history,
      ],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("❌ Error en IA:", err.message);
    return "Perdón, tuve un problema procesando tu respuesta. ¿Podrías repetirla?";
  }
};

// --- DOCUMENTOS SEGÚN TIPO DE TRABAJADOR ---
const requiredDocs = {
  dependiente: [
    "3 últimas liquidaciones de sueldo",
    "Cédula de Identidad por ambos lados",
    "Cotizaciones AFP (últimos 12 meses)",
  ],
  independiente: [
    "Cédula de Identidad por ambos lados",
    "Declaración Anual de Impuestos DAI del año en curso (Formulario 22)",
    "Carpeta Tributaria Personal",
    "Últimas 6 boletas emitidas",
  ],
  socio: [
    "Cédula de Identidad por ambos lados",
    "Declaración Anual de Impuestos DAI Empresa (Formulario 22)",
    "Declaración Anual de Impuestos DAI Personal (Formulario 22)",
    "Último Balance Empresa",
    "Carpeta Tributaria Empresa",
    "Cotizaciones AFP (últimos 12 meses)",
    "3 últimas liquidaciones de sueldo",
  ],
};

// --- FLUJO DE CONVERSACIÓN ---
const steps = [
  "Primero, necesito hacerte un par de preguntas. ¿Podrías confirmarme tu RUT?",
  "¿Es tu primera vivienda? (Sí / No)",
  "¿Qué tipo de vivienda es? (casa/departamento)",
  "¿Cuál es el precio de compra de tu propiedad? (en UF)",
  "¿Qué tipo de trabajador eres?\n1) Dependiente\n2) Independiente\n3) Socio Empresa",
];

app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body?.From;
  const body = (req.body?.Body || "").trim();
  const numMedia = parseInt(req.body?.NumMedia || "0");
  const hasMedia = numMedia > 0;

  if (!from) return;

  if (!conversations[from]) {
    conversations[from] = { step: 0, data: {}, history: [] };
    await sendWhatsAppTemplate(from, "Cliente");
    return;
  }

  const convo = conversations[from];
  convo.history.push({ role: "user", content: body });

  try {
    // --- Paso 0: Primer mensaje después del template ---
    if (convo.step === 0) {
      convo.step = 1;
      await sendWhatsAppMessage(from, steps[0]);
      return;
    }

    // --- Paso 1: RUT ---
    if (convo.step === 1) {
      convo.data.rut = body;
      convo.step = 2;
      await sendWhatsAppMessage(from, steps[1]);
      return;
    }

    // --- Paso 2: Primera vivienda ---
    if (convo.step === 2) {
      convo.data.primera_vivienda = /^s/i.test(body) ? "Sí" : "No";
      convo.step = 3;
      await sendWhatsAppMessage(from, steps[2]);
      return;
    }

    // --- Paso 3: Tipo de vivienda ---
    if (convo.step === 3) {
      convo.data.tipo_vivienda = /casa/i.test(body) ? "Casa" : "Departamento";
      convo.step = 4;
      await sendWhatsAppMessage(from, steps[3]);
      return;
    }

    // --- Paso 4: Precio UF ---
    if (convo.step === 4) {
      convo.data.precio_uf = body;
      convo.step = 5;
      await sendWhatsAppMessage(from, steps[4]);
      return;
    }

    // --- Paso 5: Tipo de trabajador ---
    if (convo.step === 5) {
      let tipo = "";
      if (/1|depend/i.test(body)) tipo = "dependiente";
      else if (/2|indepen/i.test(body)) tipo = "independiente";
      else if (/3|socio/i.test(body)) tipo = "socio";

      if (!tipo) {
        await sendWhatsAppMessage(from, "Por favor, indícanos tu tipo de trabajador (1, 2 o 3).");
        return;
      }

      convo.data.tipo_trabajador = tipo;
      convo.step = 6;

      const docs = requiredDocs[tipo];
      await sendWhatsAppMessage(
        from,
        `📄 Documentos requeridos (${tipo.charAt(0).toUpperCase() + tipo.slice(1)}):\n- ${docs.join(
          "\n- "
        )}\n\nPor favor envíalos aquí uno por uno o todos juntos.`
      );
      return;
    }

    // --- Paso 6: Recepción de documentos ---
    if (convo.step === 6) {
      if (hasMedia) {
        convo.data.docs = (convo.data.docs || 0) + numMedia;
        await sendWhatsAppMessage(from, "📎 Documento recibido. Gracias 🙌");
      } else {
        const aiReply = await askAI([
          { role: "user", content: `El cliente dice: ${body}. Está en el paso de envío de documentos.` },
        ]);
        await sendWhatsAppMessage(from, aiReply);
      }

      // Si ya envió al menos 3 archivos, cerrar conversación
      if ((convo.data.docs || 0) >= 3) {
        convo.step = 7;
        await sendWhatsAppMessage(
          from,
          "✅ Gracias, todos los documentos fueron recibidos correctamente. Iniciaremos la evaluación crediticia. ¡Nos vemos! 👋"
        );
        delete conversations[from];
      }
    }
  } catch (err) {
    console.error("❌ Error en webhook Twilio:", err.message);
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MarIA corriendo en puerto ${PORT}`));

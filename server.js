import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import axios from "axios";
import fs from "fs";
import FormData from "form-data";
import fetch from "node-fetch";
import OpenAI from "openai";

dotenv.config();

console.log("🔑 MONDAY_API_KEY:", process.env.MONDAY_API_KEY ? "OK (existe)" : "❌ NO CARGÓ");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_FILE_COLUMN_ID = process.env.MONDAY_FILE_COLUMN_ID || "file_mkxk75xt";
const MONDAY_PHONE_COLUMN_ID = process.env.MONDAY_ITEM_ID_COLUMN || "phone_mkxkb8na"; // teléfono
const MONDAY_RUT_COLUMN_ID = "text_mkxkf0sn"; // columna RUT
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID;
const WHATSAPP_TEMPLATE_SID = "HX66fce12d7c4708fbe29bf356bc539a53";

const conversations = {};

// ---------------- HELPERS ----------------
const sendWhatsAppMessage = async (to, body) => {
  try {
    await client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
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

// ---------------- UTILIDADES ----------------
function normalizeRut(rut) {
  return rut.replace(/[.\-]/g, "").toUpperCase();
}

// Buscar si el RUT existe; si no, pedir nombre
async function findOrCreateMondayItem(from, rut) {
  const cleanRut = normalizeRut(rut);
  console.log("🔍 Buscando cliente con RUT:", cleanRut);

  const query = `
    query {
      boards(ids: ${MONDAY_BOARD_ID}) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values { id text }
          }
        }
      }
    }`;

  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Authorization": MONDAY_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  const items = data?.data?.boards?.[0]?.items_page?.items || [];

  // Buscar coincidencia exacta
  const existing = items.find(item => {
    const rutCol = item.column_values.find(c => c.id === MONDAY_RUT_COLUMN_ID);
    return rutCol?.text && normalizeRut(rutCol.text) === cleanRut;
  });

  if (existing) {
    console.log("📋 Cliente encontrado:", existing.id, existing.name);
    return { id: existing.id, nuevo: false };
  }

  // No existe → pedir nombre
  conversations[from].pendingRut = rut;
  conversations[from].step = "ask_name";
  await sendWhatsAppMessage(from, "No encontré tu RUT en el sistema 🧐. ¿Podrías indicarme tu nombre completo?");
  return { id: null, nuevo: true };
}

// ---------------- MONDAY FILE UPLOAD ----------------
const uploadToMonday = async (itemId, filePath, fileName) => {
  const query = `
    mutation ($file: File!) {
      add_file_to_column (item_id: ${itemId}, column_id: "${MONDAY_FILE_COLUMN_ID}", file: $file) {
        id
      }
    }`;
  const form = new FormData();
  form.append("query", query);
  form.append("variables[file]", fs.createReadStream(filePath));

  const response = await fetch("https://api.monday.com/v2/file", {
    method: "POST",
    headers: { Authorization: MONDAY_API_KEY },
    body: form,
  });

  const result = await response.json();
  console.log("📤 Subida a Monday:", result);
};

const handleFileUpload = async (from, url, itemId) => {
  const filename = url.split("/").pop();
  const localPath = `./uploads/${filename}`;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
    },
  });

  fs.writeFileSync(localPath, response.data);
  console.log(`📁 Archivo guardado localmente: ${filename}`);

  await uploadToMonday(itemId, localPath, filename);
  fs.unlinkSync(localPath);
  console.log(`✅ Archivo subido y eliminado: ${filename}`);
};

// ---------------- FLUJO ----------------
const steps = [
  "Primero, necesito hacerte un par de preguntas. ¿Podrías confirmarme tu RUT?",
  "¿Es tu primera vivienda? (Sí / No)",
  "¿Qué tipo de vivienda es? (casa/departamento)",
  "¿Cuál es el precio de compra de tu propiedad? (en UF)",
  "¿Qué tipo de trabajador eres?\n1) Dependiente\n2) Independiente\n3) Socio Empresa",
];

const requiredDocs = {
  dependiente: ["3 últimas liquidaciones", "cedula", "cotizaciones AFP 12 meses", "informe de deuda CMF"],
  independiente: ["cedula", "dai", "carpeta", "boletas", "informe de deuda CMF"],
  socio: [
    "cedula",
    "dai empresa",
    "dai personal",
    "balance",
    "carpeta",
    "cotizaciones AFP 12 meses",
    "3 últimas liquidaciones",
    "informe de deuda CMF",
  ],
};

// ---------------- WHATSAPP WEBHOOK ----------------
app.post("/whatsapp-webhook", async (req, res) => {
  res.status(200).send("OK");

  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const numMedia = parseInt(req.body.NumMedia || "0");
  if (!from) return;

  if (!conversations[from]) {
    conversations[from] = { step: 0, data: {}, receivedDocs: [] };
    await sendWhatsAppTemplate(from, "Cliente");
    return;
  }

  const convo = conversations[from];
  try {
    // Paso inicial
    if (convo.step === 0) {
      convo.step = 1;
      await sendWhatsAppMessage(from, steps[0]);
      return;
    }

    // Paso 1: pedir y verificar RUT
    if (convo.step === 1) {
      convo.data.rut = body;
      const result = await findOrCreateMondayItem(from, body);
      if (result.nuevo) return; // espera el nombre
      convo.itemId = result.id;
      convo.step = 2;
      await sendWhatsAppMessage(from, steps[1]);
      return;
    }

    // Si estamos esperando nombre
    if (convo.step === "ask_name") {
      const nombre = body.trim();
      convo.data.nombre = nombre;
      const rut = convo.pendingRut;
      const telefono = from.replace("whatsapp:", "");

      const mutation = `
        mutation {
          create_item (
            board_id: ${MONDAY_BOARD_ID},
            item_name: "${nombre}",
            column_values: "{\\"${MONDAY_RUT_COLUMN_ID}\\": \\"${rut}\\", \\"${MONDAY_PHONE_COLUMN_ID}\\": \\"${telefono}\\"}"
          ) {
            id
          }
        }`;

      const response = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { "Authorization": MONDAY_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ query: mutation }),
      });

      const data = await response.json();
      const newId = data?.data?.create_item?.id;
      console.log("🆕 Nuevo cliente creado:", newId);

      convo.itemId = newId;
      convo.step = 2;
      await sendWhatsAppMessage(from, `Gracias ${nombre} 🙌. Continuemos con tu proceso.`);
      await sendWhatsAppMessage(from, steps[1]);
      return;
    }

    // Resto del flujo (pasos 2 en adelante)
    if (convo.step === 2) {
      convo.step = 3;
      await sendWhatsAppMessage(from, steps[2]);
      return;
    }

    if (convo.step === 3) {
      convo.step = 4;
      await sendWhatsAppMessage(from, steps[3]);
      return;
    }

    if (convo.step === 4) {
      convo.step = 5;
      await sendWhatsAppMessage(from, steps[4]);
      return;
    }

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
        `📄 Documentos requeridos (${tipo}):\n- ${docs.join("\n- ")}\n\nPor favor envíalos aquí.`
      );
      return;
    }

    if (convo.step === 6 && numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        await handleFileUpload(from, mediaUrl, convo.itemId);
      }

      convo.receivedDocs.push(...Array(numMedia).fill("ok"));
      const expected = requiredDocs[convo.data.tipo_trabajador];

      if (convo.receivedDocs.length >= expected.length) {
        await sendWhatsAppMessage(
          from,
          "✅ Gracias, todos los documentos fueron recibidos correctamente. Iniciaremos la evaluación crediticia. ¡Nos vemos! 👋"
        );
        delete conversations[from];
      } else {
        await sendWhatsAppMessage(from, "📎 Documento recibido. Si tienes más, envíalos a continuación.");
      }
    }
  } catch (err) {
    console.error("❌ Error en webhook Twilio:", err.message);
  }
});

// ---------------- SERVIDOR ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MarIA corriendo en puerto ${PORT}`));

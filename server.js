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

// --- LOG DE VARIABLES DE ENTORNO ---
console.log("🔑 MONDAY_API_KEY:", process.env.MONDAY_API_KEY ? "OK ✅" : "❌ NO CARGÓ");

// --- CONFIGURACIÓN BASE ---
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- CLIENTES EXTERNOS ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- CONSTANTES ---
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_FILE_COLUMN_ID = process.env.MONDAY_FILE_COLUMN_ID || "file_mkxk75xt";
const MONDAY_ITEM_ID_COLUMN = process.env.MONDAY_ITEM_ID_COLUMN || "phone_mkxkb8na";
const MONDAY_RUT_COLUMN_ID = "text_mkxkf0sn";
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID;
const WHATSAPP_TEMPLATE_SID = "HX66fce12d7c4708fbe29bf356bc539a53";

const conversations = {};

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

// --- SUBIDA DE ARCHIVOS A MONDAY ---
const uploadToMonday = async (itemId, filePath) => {
  const query = `
    mutation ($file: File!) {
      add_file_to_column(item_id: ${itemId}, column_id: "${MONDAY_FILE_COLUMN_ID}", file: $file) {
        id
      }
    }
  `;

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

// --- DESCARGA Y SUBIDA DE ARCHIVOS ---
const handleFileUpload = async (from, url, itemId) => {
  const filename = url.split("/").pop();
  const localPath = `./uploads/${filename}`;

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64")}`,
      },
    });

    fs.writeFileSync(localPath, response.data);
    console.log(`📁 Archivo guardado localmente: ${filename}`);

    await uploadToMonday(itemId, localPath);
    fs.unlinkSync(localPath);
    console.log(`✅ Archivo subido y eliminado: ${filename}`);
  } catch (err) {
    console.error("❌ Error manejando archivo:", err.message);
  }
};

// --- DOCUMENTOS REQUERIDOS ---
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

// --- PASOS DEL FLUJO ---
const steps = [
  "Primero, necesito hacerte un par de preguntas. ¿Podrías confirmarme tu RUT?",
  "¿Es tu primera vivienda? (Si / No)",
  "¿Qué tipo de vivienda es? (casa/departamento)",
  "¿Cuál es el precio de compra de tu propiedad? (en UF)",
  "¿Qué tipo de trabajador eres?\n1) Dependiente\n2) Independiente\n3) Socio Empresa",
];

// --- WEBHOOK DE WHATSAPP ---
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
    if (convo.step === 0) {
      convo.step = 1;
      await sendWhatsAppMessage(from, steps[0]);
      return;
    }

    if (convo.step === 1) {
      convo.data.rut = body;
      convo.itemId = await findOrCreateMondayItem(body);
      convo.step = 2;
      await sendWhatsAppMessage(from, steps[1]);
      return;
    }

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

// --- WEBHOOK DE MONDAY ---
app.post("/monday-webhook", async (req, res) => {
  console.log("📩 Webhook recibido desde Monday:", JSON.stringify(req.body, null, 2));

  const event = req.body.event;
  if (!event || !event.pulseId) return res.status(400).send("Evento inválido");

  const itemId = event.pulseId;
  console.log(`🧭 Evento de Monday para item ${itemId} (${event.pulseName})`);

  try {
    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          column_values { id text value type }
        }
      }
    `;

    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: MONDAY_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    const item = data?.data?.items?.[0];
    if (!item) {
      console.log("⚠️ No se encontró el item");
      return res.status(200).send("Item no encontrado");
    }

    // Extraer teléfono
    const phoneColumn = item.column_values.find((c) => c.id === MONDAY_ITEM_ID_COLUMN);
    let telefono = null;

    if (phoneColumn && phoneColumn.value) {
      try {
        const parsed = JSON.parse(phoneColumn.value);
        telefono = parsed.phone;
      } catch {
        telefono = phoneColumn.text || phoneColumn.value;
      }
    }

    if (!telefono) {
      console.log(`⚠️ No se encontró número de teléfono en la columna '${MONDAY_ITEM_ID_COLUMN}'`);
      return res.status(200).send("Sin número de teléfono");
    }

    console.log(`📞 Teléfono encontrado: ${telefono}`);

    // Enviar mensaje de WhatsApp
    await sendWhatsAppTemplate(`whatsapp:+${telefono}`, item.name || "Cliente");
    res.status(200).send("Mensaje enviado");
  } catch (err) {
    console.error("❌ Error procesando webhook de Monday:", err.message);
    res.status(500).send("Error interno");
  }
});

// --- FUNCIÓN: BUSCAR O CREAR ITEM EN MONDAY ---
async function findOrCreateMondayItem(rut) {
  const query = `
    query {
      items_page_by_column_values(
        board_id: ${MONDAY_BOARD_ID},
        columns: [{ column_id: "${MONDAY_RUT_COLUMN_ID}", column_value: "${rut}" }]
      ) {
        items { id name }
      }
    }
  `;

  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: MONDAY_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  const existing = data?.data?.items_page_by_column_values?.items?.[0];

  if (existing) {
    console.log("📋 Cliente encontrado:", existing.id);
    return existing.id;
  }

  const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD_ID},
        item_name: "Cliente ${rut}",
        column_values: "{\\"${MONDAY_RUT_COLUMN_ID}\\": \\"${rut}\\"}"
      ) { id }
    }
  `;

  const createRes = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: MONDAY_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation }),
  });

  const newItem = await createRes.json();
  console.log("🆕 Item creado:", newItem.data.create_item.id);
  return newItem.data.create_item.id;
}

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MarIA corriendo en puerto ${PORT}`));

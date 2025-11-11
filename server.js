import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// 1️⃣ Recibir webhook desde Monday
app.post("/monday-webhook", async (req, res) => {
  try {
    console.log("Webhook recibido:", req.body);

    const event = req.body.event;
    const itemId = event?.pulseId;
    const boardId = event?.boardId;

    // 2️⃣ Consultar datos del nuevo ítem
    const query = `
      query {
        items (ids: ${itemId}) {
          name
          column_values {
            id
            text
          }
        }
      }`;

    const mondayResponse = await axios.post(
      "https://api.monday.com/v2",
      { query },
      { headers: { Authorization: process.env.MONDAY_API_KEY } }
    );

    const item = mondayResponse.data.data.items[0];
    const nombre = item.name;
    const telefono = item.column_values.find(c => c.id === "telefono")?.text;

    // 3️⃣ Enviar mensaje inicial por WhatsApp
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${telefono}`,
      body: `👋 Hola ${nombre}, te saluda el asistente hipotecario de Inmobiliaria X. 
Queremos acompañarte en tu proceso de crédito. ¿Podrías confirmar algunos datos para comenzar?`
    });

    // 4️⃣ Actualizar estado en Monday
    const mutation = `
      mutation {
        change_column_value (
          item_id: ${itemId},
          column_id: "estado",
          value: "\"Contactado\""
        ) {
          id
        }
      }`;

    await axios.post(
      "https://api.monday.com/v2",
      { query: mutation },
      { headers: { Authorization: process.env.MONDAY_API_KEY } }
    );

    console.log("✅ Mensaje enviado y estado actualizado.");
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT, () =>
  console.log(`Servidor activo en puerto ${process.env.PORT}`)
);

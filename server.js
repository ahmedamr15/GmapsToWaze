import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.get("/telegram-webhook", (req, res) => {
  res.send("Webhook endpoint is ready. Telegram should use POST here.");
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;
    const message = update.message;

    if (!message || !message.chat) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (!text) {
      await sendTelegramMessage(
        chatId,
        "Send me a Google Maps link and I will reply with a Waze link."
      );
      return res.status(200).json({ ok: true });
    }

    const wazeLink = await buildWazeLink(text);

    if (wazeLink) {
      await sendTelegramMessage(chatId, `Waze link:\n${wazeLink}`);
    } else {
      await sendTelegramMessage(
        chatId,
        "I could not parse that Google Maps link. Send a full Google Maps URL or coordinates like 30.0444,31.2357"
      );
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ ok: false });
  }
});

async function buildWazeLink(input) {
  const expandedInput = await expandGoogleMapsUrl(input);

  const coords = extractCoords(expandedInput);
  if (coords) {
    return `https://waze.com/ul?ll=${coords.lat},${coords.lon}&navigate=yes`;
  }

  const query = extractQuery(expandedInput);
  if (query) {
    return `https://waze.com/ul?q=${encodeURIComponent(query)}`;
  }

  return null;
}

async function expandGoogleMapsUrl(input) {
  const text = input.trim();

  if (
    text.startsWith("https://maps.app.goo.gl/") ||
    text.startsWith("http://maps.app.goo.gl/") ||
    text.startsWith("https://goo.gl/maps/") ||
    text.startsWith("http://goo.gl/maps/")
  ) {
    try {
      const response = await fetch(text, {
        method: "GET",
        redirect: "follow"
      });

      return response.url || text;
    } catch (error) {
      console.error("Failed to expand short Google Maps URL:", error);
      return text;
    }
  }

  return text;
}

function extractCoords(text) {
  const decoded = safeDecode(text);

  const patterns = [
    /[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /\/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) {
      return { lat: match[1], lon: match[2] };
    }
  }

  return null;
}

function extractQuery(text) {
  const decoded = safeDecode(text);

  try {
    const url = new URL(decoded);

    const candidates = [
      url.searchParams.get("q"),
      url.searchParams.get("query"),
      url.searchParams.get("destination"),
      url.searchParams.get("daddr")
    ].filter(Boolean);

    for (const value of candidates) {
      const cleaned = value.trim();
      const looksLikeCoords = /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(cleaned);
      if (!looksLikeCoords) {
        return cleaned;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error: ${errorText}`);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

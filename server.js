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
  const resolved = await resolveGoogleMapsInput(input);

  if (resolved.coords) {
    return `https://waze.com/ul?ll=${resolved.coords.lat},${resolved.coords.lon}&navigate=yes`;
  }

  if (resolved.query) {
    return `https://waze.com/ul?q=${encodeURIComponent(resolved.query)}&navigate=yes`;
  }

  return null;
}

async function resolveGoogleMapsInput(input) {
  const text = safeDecode(input.trim());

  // 1) Direct parsing from original text
  const directCoords = extractCoords(text);
  if (directCoords) {
    return { coords: directCoords, query: null };
  }

  const directQuery = extractQuery(text);
  if (directQuery) {
    return { coords: null, query: directQuery };
  }

  // 2) Expand short links / follow redirects
  const expandedUrl = await expandGoogleMapsUrl(text);

  const expandedCoords = extractCoords(expandedUrl);
  if (expandedCoords) {
    return { coords: expandedCoords, query: null };
  }

  const expandedQuery = extractQuery(expandedUrl);
  if (expandedQuery) {
    return { coords: null, query: expandedQuery };
  }

  // 3) Fetch HTML and try to extract hidden map info
  const html = await fetchPageHtml(expandedUrl || text);
  if (html) {
    const htmlCoords = extractCoordsFromHtml(html);
    if (htmlCoords) {
      return { coords: htmlCoords, query: null };
    }

    const htmlQuery = extractQueryFromHtml(html);
    if (htmlQuery) {
      return { coords: null, query: htmlQuery };
    }
  }

  return { coords: null, query: null };
}

async function expandGoogleMapsUrl(input) {
  const text = input.trim();

  if (!looksLikeUrl(text)) {
    return text;
  }

  try {
    const response = await fetch(text, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    return response.url || text;
  } catch (error) {
    console.error("Failed to expand Google Maps URL:", error);
    return text;
  }
}

async function fetchPageHtml(url) {
  if (!looksLikeUrl(url)) return null;

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return null;
    }

    return await response.text();
  } catch (error) {
    console.error("Failed to fetch page HTML:", error);
    return null;
  }
}

function extractCoords(text) {
  const decoded = safeDecode(text);

  const patterns = [
    /[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&](?:destination|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /\/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
    /!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/i,
    /\b(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\b/
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) {
      // handle !4d lng !3d lat case
      if (pattern.source.includes("!4d") && pattern.source.includes("!3d") && match[0].startsWith("!4d")) {
        return normalizeCoords(match[2], match[1]);
      }

      return normalizeCoords(match[1], match[2]);
    }
  }

  return null;
}

function extractCoordsFromHtml(html) {
  const decoded = safeDecode(stripUnicodeEscapes(html));

  const patterns = [
    /https?:\/\/www\.google\.[^"' ]*\/maps[^"' ]*/gi,
    /https?:\/\/maps\.google\.[^"' ]*\/maps[^"' ]*/gi
  ];

  for (const pattern of patterns) {
    const matches = decoded.match(pattern) || [];
    for (const candidate of matches) {
      const coords = extractCoords(candidate);
      if (coords) return coords;
    }
  }

  const directPatterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
    /"latitude":\s*(-?\d+(?:\.\d+)?).*?"longitude":\s*(-?\d+(?:\.\d+)?)/is,
    /"lat":\s*(-?\d+(?:\.\d+)?).*?"lng":\s*(-?\d+(?:\.\d+)?)/is,
    /"center":\s*\{\s*"lat":\s*(-?\d+(?:\.\d+)?),\s*"lng":\s*(-?\d+(?:\.\d+)?)\s*\}/is
  ];

  for (const pattern of directPatterns) {
    const match = decoded.match(pattern);
    if (match) {
      return normalizeCoords(match[1], match[2]);
    }
  }

  return null;
}

function extractQuery(text) {
  const decoded = safeDecode(text);

  if (!looksLikeUrl(decoded)) {
    return null;
  }

  try {
    const url = new URL(decoded);

    const candidates = [
      url.searchParams.get("q"),
      url.searchParams.get("query"),
      url.searchParams.get("destination"),
      url.searchParams.get("daddr")
    ].filter(Boolean);

    for (const value of candidates) {
      const cleaned = cleanPlaceText(value);
      if (cleaned && !looksLikeCoordinateText(cleaned)) {
        return cleaned;
      }
    }

    const pathMatch = decoded.match(/\/maps\/place\/([^/?]+)/i);
    if (pathMatch) {
      const cleaned = cleanPlaceText(pathMatch[1].replace(/\+/g, " "));
      if (cleaned) return cleaned;
    }

    return null;
  } catch {
    return null;
  }
}

function extractQueryFromHtml(html) {
  const decoded = safeDecode(stripUnicodeEscapes(html));

  const titleMatch =
    decoded.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    decoded.match(/<title>([^<]+)<\/title>/i);

  if (titleMatch) {
    const cleaned = cleanPlaceText(titleMatch[1]);
    if (cleaned && !isGenericGoogleTitle(cleaned)) {
      return cleaned;
    }
  }

  const placeMatch = decoded.match(/\/maps\/place\/([^/"'?<]+)/i);
  if (placeMatch) {
    const cleaned = cleanPlaceText(placeMatch[1].replace(/\+/g, " "));
    if (cleaned) return cleaned;
  }

  return null;
}

function normalizeCoords(lat, lon) {
  const parsedLat = Number.parseFloat(String(lat).trim());
  const parsedLon = Number.parseFloat(String(lon).trim());

  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
    return null;
  }

  if (parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) {
    return null;
  }

  return {
    lat: parsedLat.toString(),
    lon: parsedLon.toString()
  };
}

function cleanPlaceText(value) {
  if (!value) return null;

  const cleaned = safeDecode(String(value))
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b-\s*Google Maps\b/i, "")
    .replace(/\bVisit\b.*$/i, "")
    .trim();

  return cleaned || null;
}

function looksLikeCoordinateText(value) {
  return /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(value.trim());
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isGenericGoogleTitle(value) {
  const v = value.trim().toLowerCase();
  return (
    v === "google maps" ||
    v === "maps" ||
    v.startsWith("google maps -") ||
    v.startsWith("google maps ")
  );
}

function stripUnicodeEscapes(text) {
  try {
    return text
      .replace(/\\u003d/g, "=")
      .replace(/\\u0026/g, "&")
      .replace(/\\u002F/g, "/")
      .replace(/\\u003a/gi, ":");
  } catch {
    return text;
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

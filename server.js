import express from "express";
import pg from "pg";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const PLAN_1M_STARS = 50;
const PLAN_3M_STARS = 150;
const PLAN_6M_STARS = 250;
const PLAN_12M_STARS = 350;

const MONTHLY_SUBSCRIPTION_SECONDS = 2592000; // Telegram recurring subscriptions are currently 30 days only

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.get("/telegram-webhook", (req, res) => {
  res.send("Webhook endpoint is ready. Telegram should use POST here.");
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.pre_checkout_query) {
      await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
      return res.status(200).json({ ok: true });
    }

    if (update.message?.successful_payment) {
      await handleSuccessfulPayment(update.message);
      return res.status(200).json({ ok: true });
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    if (update.message) {
      await handleMessage(update.message);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ ok: false });
  }
});

async function handleMessage(message) {
  const chatId = message.chat.id;
  const telegramId = message.from?.id;
  const username = message.from?.username || null;
  const firstName = message.from?.first_name || null;
  const text = (message.text || "").trim();

  if (!telegramId) return;

  await ensureUser({ telegramId, username, firstName });

  if (text === "/start") {
    await sendMessage(
      chatId,
      [
        "Welcome to Gmaps->Waze.",
        "",
        "Send me a Google Maps link and I will convert it to a Waze link.",
        "You get 3 free trials.",
        "",
        "Plans:",
        `• 1 month: ${PLAN_1M_STARS} Stars`,
        `• 3 months: ${PLAN_3M_STARS} Stars`,
        `• 6 months: ${PLAN_6M_STARS} Stars`,
        `• 12 months: ${PLAN_12M_STARS} Stars`,
        "",
        "Commands:",
        "/plans - show paid plans",
        "/status - show your access status"
      ].join("\n")
    );
    return;
  }

  if (text === "/plans") {
    await sendPlans(chatId);
    return;
  }

  if (text === "/status") {
    const user = await getUser(telegramId);
    await sendMessage(chatId, describeUserStatus(user));
    return;
  }

  if (!text) {
    await sendMessage(chatId, "Send me a Google Maps link.");
    return;
  }

  const user = await getUser(telegramId);
  const access = getAccessState(user);

  if (!access.allowed) {
    await sendPlans(chatId, true);
    return;
  }

  const wazeResult = await buildWazeLink(text);

  if (!wazeResult?.url) {
    await sendMessage(
      chatId,
      "I could not parse that Google Maps link. Send a full Google Maps URL, short Google Maps link, or coordinates like 30.0444,31.2357"
    );
    return;
  }

  if (access.usedTrial) {
    await incrementTrial(telegramId);
  }

  const prefix = access.usedTrial
    ? `Free trial ${user.free_trials_used + 1}/3\n\n`
    : "";

  await sendMessage(chatId, `${prefix}Waze link:\n${wazeResult.url}`);
}

async function sendPlans(chatId, includeBlockedText = false) {
  const text = [
    includeBlockedText ? "You used your 3 free trials.\n" : "",
    "Choose a plan:",
    `• 1 month: ${PLAN_1M_STARS} Stars`,
    `• 3 months: ${PLAN_3M_STARS} Stars`,
    `• 6 months: ${PLAN_6M_STARS} Stars`,
    `• 12 months: ${PLAN_12M_STARS} Stars`
  ].join("\n");

  await sendMessage(chatId, text, {
    inline_keyboard: [
      [{ text: `1 month - ${PLAN_1M_STARS}⭐`, callback_data: "buy_1m" }],
      [{ text: `3 months - ${PLAN_3M_STARS}⭐`, callback_data: "buy_3m" }],
      [{ text: `6 months - ${PLAN_6M_STARS}⭐`, callback_data: "buy_6m" }],
      [{ text: `12 months - ${PLAN_12M_STARS}⭐`, callback_data: "buy_12m" }]
    ]
  });
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const telegramId = callbackQuery.from?.id;
  const data = callbackQuery.data;

  if (!chatId || !telegramId || !data) return;

  if (data === "buy_1m") {
    await send1MonthInvoice(chatId, telegramId);
    await answerCallbackQuery(callbackQuery.id, "1 month invoice sent.");
    return;
  }

  if (data === "buy_3m") {
    await sendTimedInvoice(chatId, telegramId, "3m", "Gmaps->Waze 3 Months", "3 months access", PLAN_3M_STARS);
    await answerCallbackQuery(callbackQuery.id, "3 months invoice sent.");
    return;
  }

  if (data === "buy_6m") {
    await sendTimedInvoice(chatId, telegramId, "6m", "Gmaps->Waze 6 Months", "6 months access", PLAN_6M_STARS);
    await answerCallbackQuery(callbackQuery.id, "6 months invoice sent.");
    return;
  }

  if (data === "buy_12m") {
    await sendTimedInvoice(chatId, telegramId, "12m", "Gmaps->Waze 12 Months", "12 months access", PLAN_12M_STARS);
    await answerCallbackQuery(callbackQuery.id, "12 months invoice sent.");
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
}

async function send1MonthInvoice(chatId, telegramId) {
  return telegram("sendInvoice", {
    chat_id: chatId,
    title: "Gmaps->Waze 1 Month",
    description: "Monthly subscription for unlimited Google Maps -> Waze conversions",
    payload: "plan_1m",
    provider_token: "",
    currency: "XTR",
    prices: [{ label: "1 month", amount: PLAN_1M_STARS }],
    subscription_period: MONTHLY_SUBSCRIPTION_SECONDS,
    start_parameter: `1m_${telegramId}`
  });
}

async function sendTimedInvoice(chatId, telegramId, payloadSuffix, title, description, amount) {
  return telegram("sendInvoice", {
    chat_id: chatId,
    title,
    description,
    payload: `plan_${payloadSuffix}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: title, amount }],
    start_parameter: `${payloadSuffix}_${telegramId}`
  });
}

async function handleSuccessfulPayment(message) {
  const telegramId = message.from?.id;
  const chatId = message.chat.id;
  const payment = message.successful_payment;

  if (!telegramId || !payment) return;

  const payload = payment.invoice_payload;
  const chargeId = payment.telegram_payment_charge_id;
  const currency = payment.currency;
  const totalAmount = payment.total_amount;

  if (payload === "plan_1m") {
    const expiresAt = payment.subscription_expiration_date
      ? new Date(payment.subscription_expiration_date * 1000)
      : addMonths(new Date(), 1);

    await activatePlan({
      telegramId,
      planType: "1m",
      chargeId,
      currency,
      totalAmount,
      expiresAt,
      recurring: true
    });

    await sendMessage(chatId, `Payment successful.\n1 month access active until ${expiresAt.toISOString()}`);
    return;
  }

  if (payload === "plan_3m") {
    const expiresAt = addMonths(new Date(), 3);
    await activatePlan({
      telegramId,
      planType: "3m",
      chargeId,
      currency,
      totalAmount,
      expiresAt,
      recurring: false
    });
    await sendMessage(chatId, `Payment successful.\n3 months access active until ${expiresAt.toISOString()}`);
    return;
  }

  if (payload === "plan_6m") {
    const expiresAt = addMonths(new Date(), 6);
    await activatePlan({
      telegramId,
      planType: "6m",
      chargeId,
      currency,
      totalAmount,
      expiresAt,
      recurring: false
    });
    await sendMessage(chatId, `Payment successful.\n6 months access active until ${expiresAt.toISOString()}`);
    return;
  }

  if (payload === "plan_12m") {
    const expiresAt = addMonths(new Date(), 12);
    await activatePlan({
      telegramId,
      planType: "12m",
      chargeId,
      currency,
      totalAmount,
      expiresAt,
      recurring: false
    });
    await sendMessage(chatId, `Payment successful.\n12 months access active until ${expiresAt.toISOString()}`);
  }
}

async function activatePlan({
  telegramId,
  planType,
  chargeId,
  currency,
  totalAmount,
  expiresAt,
  recurring
}) {
  await pool.query("BEGIN");
  try {
    await pool.query(
      `
      UPDATE users
      SET access_expires_at = $2,
          active_plan = $3,
          recurring_charge_id = $4,
          updated_at = NOW()
      WHERE telegram_id = $1
      `,
      [telegramId, expiresAt, planType, recurring ? chargeId : null]
    );

    await pool.query(
      `
      INSERT INTO payments (
        telegram_id,
        plan_type,
        telegram_payment_charge_id,
        total_amount,
        currency,
        subscription_expiration_date
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (telegram_payment_charge_id) DO NOTHING
      `,
      [telegramId, planType, chargeId, totalAmount, currency, expiresAt]
    );

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function ensureUser({ telegramId, username, firstName }) {
  await pool.query(
    `
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = NOW()
    `,
    [telegramId, username, firstName]
  );
}

async function getUser(telegramId) {
  const result = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  return result.rows[0] || null;
}

function getAccessState(user) {
  const now = new Date();
  const hasPaidAccess =
    user?.access_expires_at && new Date(user.access_expires_at) > now;

  if (hasPaidAccess) {
    return { allowed: true, usedTrial: false };
  }

  if ((user?.free_trials_used || 0) < 3) {
    return { allowed: true, usedTrial: true };
  }

  return { allowed: false, usedTrial: false };
}

function describeUserStatus(user) {
  const now = new Date();

  if (user?.access_expires_at && new Date(user.access_expires_at) > now) {
    return `Active plan: ${user.active_plan}\nExpires at: ${new Date(user.access_expires_at).toISOString()}`;
  }

  return `Free trials used: ${user?.free_trials_used || 0}/3`;
}

async function incrementTrial(telegramId) {
  await pool.query(
    `
    UPDATE users
    SET free_trials_used = free_trials_used + 1,
        updated_at = NOW()
    WHERE telegram_id = $1
    `,
    [telegramId]
  );
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage = undefined) {
  return telegram("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {})
  });
}

async function answerCallbackQuery(callbackQueryId, text = undefined) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

async function sendMessage(chatId, text, replyMarkup = null) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API error in ${method}: ${JSON.stringify(data)}`);
  }

  return data.result;
}

/* ===== MAPS -> WAZE ===== */

async function buildWazeLink(input) {
  const resolved = await resolveGoogleMapsInput(input);

  if (resolved.coords) {
    return {
      url: `https://waze.com/ul?ll=${resolved.coords.lat},${resolved.coords.lon}&navigate=yes`
    };
  }

  if (resolved.query) {
    const geocoded = await geocodePlace(resolved.query);
    if (geocoded) {
      return {
        url: `https://waze.com/ul?ll=${geocoded.lat},${geocoded.lon}&navigate=yes`
      };
    }

    return {
      url: `https://waze.com/ul?q=${encodeURIComponent(resolved.query)}&navigate=yes`
    };
  }

  return null;
}

async function resolveGoogleMapsInput(input) {
  const text = safeDecode(input.trim());

  const directCoords = extractCoords(text);
  if (directCoords) return { coords: directCoords, query: null };

  const directQuery = extractQuery(text);
  if (directQuery) return { coords: null, query: directQuery };

  const expandedUrl = await expandGoogleMapsUrl(text);

  const expandedCoords = extractCoords(expandedUrl);
  if (expandedCoords) return { coords: expandedCoords, query: null };

  const expandedQuery = extractQuery(expandedUrl);
  if (expandedQuery) return { coords: null, query: expandedQuery };

  const html = await fetchPageHtml(expandedUrl || text);
  if (html) {
    const htmlCoords = extractCoordsFromHtml(html);
    if (htmlCoords) return { coords: htmlCoords, query: null };

    const htmlQuery = extractQueryFromHtml(html);
    if (htmlQuery) return { coords: null, query: htmlQuery };
  }

  return { coords: null, query: null };
}

async function expandGoogleMapsUrl(input) {
  const text = input.trim();
  if (!looksLikeUrl(text)) return text;

  try {
    const response = await fetch(text, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    return response.url || text;
  } catch {
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
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    return await response.text();
  } catch {
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
    if (!match) continue;

    if (match[0].startsWith("!4d")) {
      return normalizeCoords(match[2], match[1]);
    }

    return normalizeCoords(match[1], match[2]);
  }

  return null;
}

function extractCoordsFromHtml(html) {
  const decoded = safeDecode(stripUnicodeEscapes(html));
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
    /"latitude":\s*(-?\d+(?:\.\d+)?).*?"longitude":\s*(-?\d+(?:\.\d+)?)/is,
    /"lat":\s*(-?\d+(?:\.\d+)?).*?"lng":\s*(-?\d+(?:\.\d+)?)/is
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) return normalizeCoords(match[1], match[2]);
  }

  return null;
}

function extractQuery(text) {
  const decoded = safeDecode(text);
  if (!looksLikeUrl(decoded)) return null;

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
      if (cleaned && !looksLikeCoordinateText(cleaned)) return cleaned;
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
    if (cleaned && !isGenericGoogleTitle(cleaned)) return cleaned;
  }

  return null;
}

async function geocodePlace(query) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "GmapsToWazeBot/1.0",
          "Accept-Language": "en-US,en;q=0.9"
        }
      }
    );

    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) return null;

    return normalizeCoords(data[0].lat, data[0].lon);
  } catch {
    return null;
  }
}

function normalizeCoords(lat, lon) {
  const parsedLat = Number.parseFloat(String(lat).trim());
  const parsedLon = Number.parseFloat(String(lon).trim());

  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) return null;

  return { lat: parsedLat.toString(), lon: parsedLon.toString() };
}

function cleanPlaceText(value) {
  if (!value) return null;

  return safeDecode(String(value))
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b-\s*Google Maps\b/i, "")
    .trim();
}

function looksLikeCoordinateText(value) {
  return /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(value.trim());
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isGenericGoogleTitle(value) {
  const v = value.trim().toLowerCase();
  return v === "google maps" || v === "maps" || v.startsWith("google maps ");
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// api/review-webhook.js
// Chatmeter → Zendesk (create ticket with internal "Review Information" note)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---- env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;   // drivohelp
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text/number
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // (optional) text/tagger

  let LOCATION_MAP = {};
  try {
    if (process.env.LOCATION_MAP_JSON) LOCATION_MAP = JSON.parse(process.env.LOCATION_MAP_JSON);
  } catch {}

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // ---- parse incoming review
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).send("Invalid JSON body");
  }

  // Canonicalize fields we care about (across providers)
  const reviewId      = body.id || body.reviewId || body.review_id || "";
  const rating        = coerceNumber(body.rating);
  const provider      = (body.provider || body.contentProvider || "").toString().trim() || "CHATMETER";
  const rawLocId      = (body.locationId || "").toString();
  const mappedLabel   = LOCATION_MAP[rawLocId];   // e.g. "LGA004 – LaGuardia Airport"
  const locationName  = body.locationName || mappedLabel || "Unknown";
  const createdAt     = body.createdAt || body.reviewDate || new Date().toISOString();
  const authorName    = pickFirst(body.authorName, body.reviewerUserName, "Customer");
  const authorEmail   = pickFirst(body.reviewerEmail, body.email, "");      // may be blank
  const authorPhone   = pickFirst(body.reviewerPhone, body.phone, "");      // may be blank
  const publicUrl     = body.publicUrl || body.reviewURL || "";
  const text =
    body.text ||
    extractReviewTextFromData(body.reviewData) ||
    ""; // might be blank for some providers

  if (!reviewId) return res.status(400).send("Missing review id");

  // ---- compose subject (clean & short)
  const subject = `${provider.toUpperCase()} ${rating || "–"}★ – ${shorten(locationName)}`;

  // ---- "Review Information" internal note (exact layout)
  const internalNote = [
    "Review Information:",
    "",
    `Date: ${createdAt}`,
    "",
    `Customer: ${authorName}`,
    authorEmail ? `${authorEmail}` : "",
    authorPhone ? `${authorPhone}` : "",
    "",
    `Location: ${locationName}`,
    "",
    "Comment:",
    text || "(no text)",
    "",
    "The first comment on this ticket will be recorded as your response to Chatmeter. Any messages after will not be",
    "sent and you can work the ticket as normal"
  ].filter(Boolean).join("\n");

  // ---- Zendesk auth
  const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const zBase = `https://${ZD_SUBDOMAIN}.zendesk.com`;

  // ---- dedupe via external_id search
  const externalId = `chatmeter:${reviewId}`;

  const foundId = await findTicketByExternalId(zBase, auth, externalId);
  if (foundId) {
    // Already exists → do NOT create a new ticket
    return res.status(200).json({ ok: true, deduped: true, via: "lookup", ticketId: foundId });
  }

  // ---- custom_fields
  const custom_fields = [];
  if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
  if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(rawLocId || "") });
  if (ZD_FIELD_RATING && rating) custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
  if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
  if (ZD_FIELD_LOCATION_NAME && locationName) {
    custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: String(locationName) });
  }

  // ---- build ticket payload
  const ticket = {
    ticket: {
      subject,
      external_id: externalId,
      requester: { name: "Chatmeter", email: "reviews@drivo.com" },  // keeps all bridge tickets tied to a neutral user
      tags: ["chatmeter", "review", provider.toLowerCase()],
      comment: {
        body: internalNote,
        public: false // <-- INTERNAL NOTE like your screenshot
      },
      custom_fields
    }
  };

  // idempotency header (second hit with same reviewId still won’t create)
  const idempKey = `chatmeter:${reviewId}`;

  // ---- create ticket
  const createRes = await fetch(`${zBase}/api/v2/tickets.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": auth,
      "Idempotency-Key": idempKey
    },
    body: JSON.stringify(ticket)
  });

  if (!createRes.ok) {
    const errTxt = await createRes.text();
    return res.status(502).send(`Zendesk create error: ${createRes.status} ${errTxt}`);
  }

  const data = await createRes.json();
  return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null });
}

// --------------------------------- helpers
function pickFirst(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim();
  return "";
}

function coerceNumber(n) {
  if (n === 0 || n === "0") return 0;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function shorten(s = "", max = 60) {
  s = String(s); 
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Chatmeter Survey/Google payloads sometimes place text in reviewData array
function extractReviewTextFromData(arr) {
  if (!Array.isArray(arr)) return "";
  // try common keys in order
  const keys = ["comment", "text", "review", "message", "body", "freeText"];
  for (const row of arr) {
    if (!row) continue;
    // name/value style
    if (row.value && typeof row.value === "string" && row.name) {
      const name = String(row.name).toLowerCase();
      if (keys.some(k => name.includes(k)) && row.value.trim()) return row.value.trim();
    }
    // direct key/value style
    for (const k of keys) {
      if (typeof row[k] === "string" && row[k].trim()) return row[k].trim();
    }
  }
  return "";
}

async function findTicketByExternalId(zBase, auth, externalId) {
  // Zendesk search: type:ticket external_id:"chatmeter:xxxx"
  const q = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
  const url = `${zBase}/api/v2/search.json?query=${q}`;
  const r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!r.ok) return null;
  const js = await r.json();
  const first = (js?.results || []).find(r => r?.external_id === externalId);
  return first?.id || null;
}

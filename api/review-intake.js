// pages/api/review-intake.js
//
// Unified Chatmeter → Zendesk intake (Google, Yelp, etc.), with:
// - strict idempotency (external_id + Idempotency-Key)
// - requester set to customer email when available
// - NPS fields included (score/category) when present
// - resilient parsing of mixed payload shapes
//
// POST only. Example minimal body:
// {
//   "platform": "google",
//   "id": "g-123",
//   "rating": 4.6,
//   "author": { "name": "John D." },
//   "content": "Great service",
//   "url": "https://...",
//   "location": { "name": "JFK" },
//   "createdAt": "2025-09-28T12:00:00Z",
//   "nps": { "score": 10, "category": "promoter" },
//   "customer": { "email": "john@example.com", "name": "John Doe" }
// }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const {
      ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL,
      ZENDESK_API_TOKEN,
      ZENDESK_BRAND_ID,
      ZENDESK_GROUP_ID,
      ZENDESK_REQUESTER_EMAIL, // fallback if no customer email
    } = process.env;

    if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) {
      return res.status(400).json({ ok: false, error: "Missing Zendesk envs" });
    }

    const zAuth = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

    // ---- Normalize inbound payload (tolerant) ----
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const platform =
      (body.platform || body.source || body.provider || "").toString().trim().toLowerCase() || "unknown";

    // prefer stable review id (from Chatmeter or platform)
    const reviewId =
      body.id ||
      body.review_id ||
      body.reviewId ||
      (body.review && (body.review.id || body.review.review_id)) ||
      null;

    if (!reviewId) {
      return res.status(400).json({ ok: false, error: "Missing review id" });
    }

    // Basic fields
    const rating = numOrNull(body.rating ?? body.score ?? body.stars);
    const authorName =
      val(body.author?.name) ||
      val(body.author_name) ||
      val(body.user?.name) ||
      val(body.reviewer) ||
      "Unknown Reviewer";
    const content = val(body.content) || val(body.text) || val(body.comment) || "(no content)";
    const reviewUrl = val(body.url) || val(body.link) || val(body.review_url) || null;

    // Location (fallbacks)
    const locationName =
      val(body.location?.name) ||
      val(body.location_name) ||
      val(body.location) ||
      val(body.store) ||
      "Unknown Location";

    // Timestamps
    const createdAt =
      val(body.createdAt) ||
      val(body.created_at) ||
      val(body.time) ||
      val(body.timestamp) ||
      new Date().toISOString();

    // NPS (optional)
    const nps = body.nps || {};
    const npsScore = numOrNull(nps.score);
    const npsCategory = (nps.category || nps.type || "").toString().toLowerCase() || null;

    // Customer identity (optional)
    const custEmail =
      val(body.customer?.email) ||
      val(body.email) ||
      val(body.customer_email) ||
      null;
    const custName =
      val(body.customer?.name) ||
      val(body.name) ||
      (custEmail ? custEmail.split("@")[0] : null) ||
      "Guest";

    // Build a stable external id and idempotency key
    const extId = `chatmeter:${platform}:${reviewId}`; // <- de-dup guard across all sources
    const idemKey = extId; // use same for Idempotency-Key

    // ---- De-duplication (search by external_id) ----
    const existing = await zGetJSON(
      `${zBase}/search.json?query=${encodeURIComponent(`type:ticket external_id:"${extId}"`)}`,
      { Authorization: zAuth }
    );

    if (existing?.results?.length) {
      const t = existing.results[0];
      return res.status(200).json({
        ok: true,
        status: "exists",
        ticket_id: t.id,
        external_id: extId,
      });
    }

    // ---- Ticket payload ----
    const subject = `[${capitalize(platform)}][${locationName}] ${shorten(content, 80)}`;

    const lines = [];
    lines.push(`Platform: ${capitalize(platform)}`);
    if (rating != null) lines.push(`Rating: ${rating}/5`);
    if (npsScore != null || npsCategory) {
      lines.push(`NPS: ${npsScore != null ? npsScore : "(n/a)"}${npsCategory ? ` (${npsCategory})` : ""}`);
    }
    lines.push(`Author: ${authorName}`);
    if (custEmail) lines.push(`Customer Email: ${custEmail}`);
    lines.push(`Location: ${locationName}`);
    lines.push(`Created At: ${createdAt}`);
    if (reviewUrl) lines.push(`Link: ${reviewUrl}`);
    lines.push("");
    lines.push("----- Review Text -----");
    lines.push(content);

    const commentBody = lines.join("\n");

    // Requester rules:
    // - If we have a valid customer email, use it as the requester (Zendesk will match/create)
    // - Else use configured fallback (ZENDESK_REQUESTER_EMAIL) or integration user
    const requester =
      isEmail(custEmail)
        ? { name: custName, email: custEmail }
        : (isEmail(ZENDESK_REQUESTER_EMAIL) ? { name: "Reviews Bot", email: ZENDESK_REQUESTER_EMAIL } : undefined);

    const ticketPayload = {
      ticket: {
        subject,
        external_id: extId, // idempotency anchor
        comment: { body: commentBody, public: true },
        tags: [
          "chatmeter",
          "review",
          sanitizeTag(platform),
          sanitizeTag(locationName),
        ],
        ...(ZENDESK_BRAND_ID ? { brand_id: tryNum(ZENDESK_BRAND_ID) } : {}),
        ...(ZENDESK_GROUP_ID ? { group_id: tryNum(ZENDESK_GROUP_ID) } : {}),
        ...(requester ? { requester } : {}),
        // You can set 'priority' or 'ticket_form_id' here if needed
      },
    };

    // ---- Create ticket with Idempotency-Key header ----
    const createResp = await fetch(`${zBase}/tickets.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: zAuth,
        "Idempotency-Key": idemKey, // Zendesk idempotency
      },
      body: JSON.stringify(ticketPayload),
    });

    if (!createResp.ok) {
      const errTxt = await createResp.text();
      return res.status(createResp.status).json({ ok: false, where: "create_ticket", detail: errTxt });
    }

    const created = await createResp.json();
    return res.status(201).json({
      ok: true,
      status: "created",
      ticket_id: created?.ticket?.id,
      external_id: extId,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

// ---------------- helpers ----------------
function val(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  return s.length ? s : null;
}
function numOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function isEmail(x) {
  if (!x) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x).trim());
}
function sanitizeTag(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 60) || "unknown";
}
function shorten(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1).trim() + "…" : t;
}
function capitalize(s) {
  s = String(s || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function tryNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
async function zGetJSON(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  return r.json();
}

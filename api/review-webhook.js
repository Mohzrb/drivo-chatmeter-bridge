// api/review-webhook.js
// Chatmeter → Zendesk (create ticket with INTERNAL "Review Information" note)
// - requester is reviews@drivo.com
// - location name shown (from payload or CHM_LOCATION_MAP env)
// - private (internal) note in the old format
// - no-op dedupe when ticket already has the same fields/tag

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // --- Zendesk env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;    // e.g., drivohelp
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;        // agent email
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;    // API token
  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // numeric/text
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // numeric
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox (false on create)

  // optional: JSON object { "1001892551":"JFK", ... }
  const LOC_MAP = safeJson(process.env.CHM_LOCATION_MAP, {});

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    // ---- payload from poller or manual test
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId || body.review_id || "";
    const provider     = (body.provider || "").toString().toUpperCase() || "UNKNOWN";
    const locationId   = body.locationId ?? "";
    const locationName = body.locationName || LOC_MAP[locationId] || "Unknown";
    const rating       = Number(body.rating ?? 0);
    const authorName   = body.authorName || "Reviewer";
    const authorEmail  = "reviews@drivo.com"; // requester we want, fixed
    const createdAt    = body.createdAt || body.reviewDate || new Date().toISOString();
    const text         = normalizeText(body);
    const publicUrl    = body.publicUrl || "";

    if (!reviewId) return res.status(400).send("Missing reviewId/id");

    // ---- subject identical to the “good” tickets
    const subject = `${locationName} – ${rating}★ – ${authorName}`;

    // ---- tags: chatmeter, provider, and a stable cmrvw_<id>
    const tagReview = `cmrvw_${reviewId}`;
    const tags = ["chatmeter", provider.toLowerCase(), "review", tagReview];

    // ---- external_id for perfect dedupe
    const external_id = `chatmeter:${reviewId}`;

    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

    // 1) try to find existing ticket by external_id
    const existing = await zdGetByExternalId(ZD_SUBDOMAIN, auth, external_id);

    // ---- build the INTERNAL note in the old format
    const note = formatInternalNote({
      id: reviewId, provider, locationId, locationName, rating, createdAt, text, publicUrl
    });

    // if we found a ticket, no-op unless something is missing
    if (existing) {
      // NO-OP guard: if tag present and all custom fields already match, return deduped
      const hasTag = (existing.tags || []).includes(tagReview);
      const fields = existing.custom_fields || [];
      const getVal = (id) => (fields.find(f => +f.id === +id) || {}).value;

      const okFields =
        String(getVal(ZD_FIELD_REVIEW_ID))   == String(reviewId) &&
        String(getVal(ZD_FIELD_LOCATION_ID)) == String(locationId) &&
        String(getVal(ZD_FIELD_RATING))      == String(rating);

      if (hasTag && okFields) {
        return res.status(200).json({ ok: true, action: "noop", deduped: true, ticketId: existing.id });
      }

      // otherwise, update once to normalize fields/tags; we do NOT add a new note
      const upd = {
        ticket: {
          tags: addUnique(existing.tags || [], tags),
          custom_fields: [
            { id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) },
            { id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) },
            { id: +ZD_FIELD_RATING,           value: Number(rating) },
          ].filter(f => !Number.isNaN(f.id) && f.id > 0),
        }
      };
      const r = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${existing.id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(upd)
      });
      if (!r.ok) return res.status(207).send(`Zendesk update failed: ${r.status} ${await r.text()}`);
      return res.status(200).json({ ok: true, action: "updated", id: existing.id, externalId: external_id });
    }

    // 2) create a fresh ticket with a PRIVATE (internal) note in the old format
    const ticket = {
      ticket: {
        subject,
        external_id,
        requester: { name: authorEmail, email: authorEmail }, // keeps requester = reviews@drivo.com
        comment: { body: note, public: false },               // INTERNAL note restored
        tags,
        custom_fields: [
          { id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) },
          { id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) },
          { id: +ZD_FIELD_RATING,           value: Number(rating) },
          ...(ZD_FIELD_FIRST_REPLY_SENT ? [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false }] : []),
        ].filter(f => !Number.isNaN(f.id) && f.id > 0),
      },
    };

    const createRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(ticket),
    });
    if (!createRes.ok) return res.status(502).send(`Zendesk create error: ${createRes.status} ${await createRes.text()}`);

    const data = await createRes.json();
    return res.status(200).json({ ok: true, action: "created", id: data.ticket.id, externalId: external_id });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------------- helpers ---------------- */

function formatInternalNote(p) {
  return [
    "Review Information:",
    "",
    `Review ID: ${p.id}`,
    `Provider: ${p.provider}`,
    `Location: ${p.locationName} (${p.locationId})`,
    `Rating: ${p.rating}★`,
    `Date: ${p.createdAt}`,
    "",
    "Review Text:",
    (p.text && p.text.trim()) ? p.text.trim() : "(no text)",
    "",
    "Public URL:",
    p.publicUrl || "(none)"
  ].join("\n");
}

function normalizeText(b) {
  // whatever the poller sent
  if (b.text && String(b.text).trim()) return String(b.text);

  // fallback to reviewData array (Chatmeter style)
  if (Array.isArray(b.reviewData)) {
    const ans = b.reviewData.find(x => /comment|text|content/i.test(x?.name || ""));
    if (ans?.value) return String(ans.value);
  }

  // provider-specific fallbacks (common cases)
  if (b.provider === "YELP" && b.extractedText) return String(b.extractedText);
  if (b.provider === "TRUSTPILOT" && b.body) return String(b.body);
  if (b.provider === "GOOGLE" && b.comment) return String(b.comment);

  return "";
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

async function zdGetByExternalId(sub, auth, external_id) {
  const url = `https://${sub}.zendesk.com/api/v2/search.json?query=${encodeURIComponent('type:ticket external_id:"' + external_id + '"')}`;
  const r = await fetch(url, { headers: { Authorization: auth, "Content-Type":"application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.results || [])[0] || null;
}

function addUnique(existing, add) {
  const s = new Set([...(existing || []), ...(add || [])]);
  return [...s];
}

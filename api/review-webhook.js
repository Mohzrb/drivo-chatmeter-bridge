// api/review-webhook.js
// Chatmeter → Zendesk (idempotent via external_id + fieldvalue + unique tag)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text/dropdown
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // optional text/dropdown

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const authBasic = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const Z = async (path, init = {}) => {
    const r = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${authBasic}`,
        ...(init.headers || {})
      }
    });
    return r;
  };

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId = String(body.id || body.reviewId || body.review_id || "").trim();
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = String(body.locationId || "");
    const locationName = String(body.locationName || "Unknown");
    const rating       = (typeof body.rating === "number" ? body.rating : Number(body.rating || 0)) || 0;
    const authorName   = body.authorName || "Chatmeter Reviewer";
    const createdAt    = body.createdAt || "";
    const text         = (body.text || body.comment || body.reviewText || "").toString();
    const publicUrl    = body.publicUrl || body.reviewURL || "";
    const provider     = (body.provider || body.contentProvider || "").toString().toUpperCase();

    // Unique keys
    const externalId = `chatmeter:${reviewId}`;
    const tagKey     = `cmrvw_${reviewId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60)}`;

    // ---- DEDUPE CHECK 1: external_id via search (fast and reliable) ----
    const q1 = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
    let r = await Z(`/api/v2/search.json?query=${q1}&per_page=1`);
    let j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.results) && j.results.length) {
      const existing = j.results[0];
      await safeTouch(existing.id, Z);
      return res.status(200).json({ ok: true, deduped: true, via: "external_id", ticketId: existing.id });
    }

    // ---- DEDUPE CHECK 2: custom field value (older tickets) ----
    const q2 = encodeURIComponent(`type:ticket fieldvalue:${reviewId}`);
    r = await Z(`/api/v2/search.json?query=${q2}&per_page=3`);
    j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.results) && j.results.length) {
      // prefer any that already has our external_id (if present), else first match
      const existing = j.results.find(t => String(t.external_id || "").endsWith(reviewId)) || j.results[0];
      await safeTouch(existing.id, Z);
      return res.status(200).json({ ok: true, deduped: true, via: "fieldvalue", ticketId: existing.id });
    }

    // ---- DEDUPE CHECK 3: unique tag fallback ----
    const q3 = encodeURIComponent(`type:ticket tags:${tagKey}`);
    r = await Z(`/api/v2/search.json?query=${q3}&per_page=1`);
    j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.results) && j.results.length) {
      const existing = j.results[0];
      await safeTouch(existing.id, Z);
      return res.status(200).json({ ok: true, deduped: true, via: "tag", ticketId: existing.id });
    }

    // ---- CREATE (first-time only) ----
    const subject = `${locationName} – ${rating}★ – ${authorName}`;
    const description = [
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "N/A"}`,
      `Location: ${locationName}${locationId ? ` (${locationId})` : ""}`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Public URL:",
      publicUrl || "(none)"
    ].filter(Boolean).join("\n");

    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: reviewId });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: locationId });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locationName) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    }

    const create = await Z(`/api/v2/tickets.json`, {
      method: "POST",
      body: JSON.stringify({
        ticket: {
          external_id: externalId,                       // de-dupe anchor
          subject,
          comment: { body: description, public: false }, // creation as internal note
          requester: { name: authorName, email: "reviews@drivo.com" },
          custom_fields,
          tags: ["chatmeter", "review", tagKey, provider.toLowerCase()].filter(Boolean)
        }
      })
    });

    const createTxt = await create.text();
    if (!create.ok) {
      return res.status(502).send(`Zendesk create error: ${create.status} ${createTxt}`);
    }
    const created = safeParse(createTxt, {});
    return res.status(200).json({ ok: true, createdTicketId: created?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// Add a tiny internal note + retag if we found a duplicate
async function safeTouch(ticketId, Z) {
  try {
    await Z(`/api/v2/tickets/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        ticket: {
          comment: { body: "Chatmeter duplicate suppressed (idempotent).", public: false },
          tags: ["chatmeter", "review", "deduped"]
        }
      })
    });
  } catch { /* ignore */ }
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

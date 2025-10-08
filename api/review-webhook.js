// api/review-webhook.js
// Chatmeter → Zendesk (idempotent): external_id lookup + Idempotency-Key on create

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // 35430266638231
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // 35440761054615
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // 35440783828759
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // 35430318419351
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // optional

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const authBasic = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const Z = (path, init={}) =>
    fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${authBasic}`,
        ...(init.headers || {})
      }
    });

  try {
    // Normalize inbound payload
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId = String(b.id || b.reviewId || b.review_id || "").trim();
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = String(b.locationId ?? "");
    const locationName = String(b.locationName ?? "Unknown");
    const rating       = (typeof b.rating === "number" ? b.rating : Number(b.rating || 0)) || 0;
    const authorName   = String(b.authorName ?? "Chatmeter Reviewer");
    const createdAt    = String(b.createdAt ?? "");
    const text         = String(b.text ?? b.comment ?? b.reviewText ?? "");
    const publicUrl    = String(b.publicUrl ?? b.reviewURL ?? "");
    const provider     = String(b.provider ?? b.contentProvider ?? "").toUpperCase();

    // Idempotency anchor
    const externalId = `chatmeter:${reviewId}`;
    const uniqueTag  = `cmrvw_${reviewId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60)}`;

    // 1) Direct external_id lookup (no search index)
    let r = await Z(`/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(externalId)}`);
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).send(`Zendesk lookup failed: ${r.status} ${t}`);
    }
    const sj = await r.json().catch(() => ({}));
    const existing = sj?.tickets?.[0];

    if (existing) {
      // Touch existing (no new ticket)
      await safeTouch(existing.id, Z);
      return res.status(200).json({ ok: true, deduped: true, via: "external_id", ticketId: existing.id });
    }

    // 2) Create (with Idempotency-Key so rapid duplicates collapse to the same ticket)
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
    if (ZD_FIELD_LOCATION_NAME && locationName)
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });

    const create = await Z(`/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Idempotency-Key": externalId }, // <- critical
      body: JSON.stringify({
        ticket: {
          external_id: externalId,
          subject,
          comment: { body: description, public: false },   // create as internal summary
          requester: { name: authorName, email: "reviews@drivo.com" },
          custom_fields,
          tags: ["chatmeter", "review", uniqueTag, provider.toLowerCase()].filter(Boolean)
        }
      })
    });
    const createTxt = await create.text();
    if (!create.ok) return res.status(502).send(`Zendesk create error: ${create.status} ${createTxt}`);
    const created = safeParse(createTxt, {});
    return res.status(200).json({ ok: true, createdTicketId: created?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

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
  } catch {}
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

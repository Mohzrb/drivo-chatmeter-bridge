// Chatmeter → Zendesk (create ticket, idempotent via external_id/custom-field check)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---- ENV ----
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // numeric
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // numeric
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // numeric
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // numeric
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // optional numeric

  const EXTERNAL_ID_PREFIX = process.env.EXTERNAL_ID_PREFIX || "chatmeter:";

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // ---- Helpers ----
  const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const z = async (path, init={}) => {
    const r = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${path}`, {
      ...init,
      headers: { "Content-Type":"application/json", "Authorization": auth, ...(init.headers||{}) }
    });
    return r;
  };
  const safe = (x, fb="") => (x === undefined || x === null) ? fb : x;

  try {
    // 1) normalize inbound
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId      = String(b.id || b.reviewId || b.review_id || "");
    if (!reviewId) return res.status(400).send("Missing review id");
    const locationId    = safe(b.locationId, "");
    const rating        = safe(b.rating, 0);
    const authorName    = safe(b.authorName, "Chatmeter Reviewer");
    const createdAt     = safe(b.createdAt, "");
    const text          = safe(b.text, "");
    const publicUrl     = safe(b.publicUrl, safe(b.reviewURL, ""));
    const provider      = safe(b.provider, safe(b.contentProvider, "")).toString().toUpperCase();
    const locNameHuman  = safe(b.locationName, "Unknown");

    // 2) Build subject/body like your current template
    const subject = `${locNameHuman} – ${rating}★ – ${authorName}`;
    const description = [
      `Update from Chatmeter bridge`,
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "UNKNOWN"}`,
      `Location: ${locNameHuman}${locationId ? ` (${locationId})` : ""}`,
      `Rating: ${rating}★`,
      `Date: ${createdAt || "(unknown)"}`,
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : ""
    ].filter(Boolean).join("\n");

    // 3) Idempotency keys
    const externalId = `${EXTERNAL_ID_PREFIX}${reviewId}`;
    const tagSafeId  = `cmrvw_${reviewId.toLowerCase()}`.replace(/[^a-z0-9_]/g, "_").slice(0, 60);

    // 4) De-dupe check A: by external_id
    const q1 = encodeURIComponent(`type:ticket external_id:${JSON.stringify(externalId)}`);
    let r = await z(`/api/v2/search.json?query=${q1}&per_page=1`);
    let data = await r.json();
    if (r.ok && Array.isArray(data.results) && data.results.length) {
      const existing = data.results[0];
      return res.status(200).json({ ok: true, duplicate: true, existing_ticket_id: existing.id, via: "external_id" });
    }

    // 5) De-dupe check B: by custom field value (Review ID)
    //    Uses search "fieldvalue:" which matches any custom field containing that value.
    const q2 = encodeURIComponent(`type:ticket fieldvalue:${reviewId}`);
    r = await z(`/api/v2/search.json?query=${q2}&per_page=3`);
    data = await r.json();
    if (r.ok && Array.isArray(data.results) && data.results.some(t => String(t.external_id||"").endsWith(reviewId))) {
      const existing = data.results.find(t => String(t.external_id||"").endsWith(reviewId));
      return res.status(200).json({ ok: true, duplicate: true, existing_ticket_id: existing.id, via: "fieldvalue" });
    }

    // 6) Create ticket (first—and only—time)
    const ticket = {
      ticket: {
        external_id: externalId,
        subject,
        comment: { body: description, public: false },        // internal note on creation
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound", tagSafeId],
        custom_fields: [
          { id: +ZD_FIELD_REVIEW_ID,   value: String(reviewId) },
          ...(ZD_FIELD_LOCATION_ID ? [{ id: +ZD_FIELD_LOCATION_ID, value: String(locationId||"") }] : []),
          ...(ZD_FIELD_RATING ? [{ id: +ZD_FIELD_RATING, value: Number(rating)||0 }] : []),
          ...(ZD_FIELD_FIRST_REPLY_SENT ? [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false }] : []),
          ...(ZD_FIELD_LOCATION_NAME ? [{ id: +ZD_FIELD_LOCATION_NAME, value: String(locNameHuman) }] : []),
        ]
      }
    };

    const createRes = await z(`/api/v2/tickets.json`, { method: "POST", body: JSON.stringify(ticket) });
    if (!createRes.ok) {
      const t = await createRes.text();
      return res.status(502).send(`Zendesk create error: ${createRes.status} ${t}`);
    }
    const created = await createRes.json();
    return res.status(200).json({ ok: true, createdTicketId: created?.ticket?.id ?? null, external_id: externalId });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

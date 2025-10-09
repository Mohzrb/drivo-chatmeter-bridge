// api/review-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // --- env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;   // e.g., "drivohelp"
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text/number
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // optional text/tagger

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // --- body
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const reviewId     = body.id || body.reviewId || body.review_id;
  const provider     = body.provider || "";
  const locationId   = body.locationId || "";
  const locationName = body.locationName || "Unknown";
  const rating       = Number(body.rating || 0);
  const authorName   = body.authorName || "Reviewer";
  const createdAt    = body.createdAt || new Date().toISOString();
  const text         = body.text || "";
  const publicUrl    = body.publicUrl || body.portalUrl || "";
  if (!reviewId) return res.status(400).send("Missing review id");

  // --- helpers
  const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const zdFetch = (url, init={}) =>
    fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${url}`, {
      ...init,
      headers: { "Content-Type":"application/json", "Authorization": auth, ...(init.headers||{}) }
    });

  const safe = s => (s ?? "").toString().replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const stars = n => {
    const v = Math.max(0, Math.min(5, Number(n)||0));
    return "★★★★★☆☆☆☆☆".slice(5 - v, 10 - v);
  };

  const subject = `${locationName} – ${rating}★ – ${authorName}${provider ? ` – ${provider}` : ""}`;

  // --- DEDUPE: by external_id or custom field
  const externalId = `chatmeter:${reviewId}`;
  let existingId = null;
  try {
    // search by external_id first (fast)
    let r = await zdFetch(`/api/v2/search.json?query=${encodeURIComponent(`type:ticket external_id:"${externalId}"`)}`);
    if (r.ok) {
      const j = await r.json();
      if (j?.results?.length) existingId = j.results[0].id;
    }
    // fallback: search by custom field value (in case external_id wasn’t set on old tickets)
    if (!existingId && ZD_FIELD_REVIEW_ID) {
      const q = `type:ticket fieldvalue:${reviewId}`;
      const r2 = await zdFetch(`/api/v2/search.json?query=${encodeURIComponent(q)}`);
      if (r2.ok) {
        const j2 = await r2.json();
        if (j2?.results?.length) existingId = j2.results[0].id;
      }
    }
  } catch {}

  if (existingId) {
    // NO further updates; do not append any notes.
    return res.status(200).json({ ok: true, deduped: true, ticketId: existingId });
  }

  // --- Build HTML card (private)
  const cardHtml = `
<div style="background:#fff4e5;border:1px solid #f5d3a3;border-radius:6px;padding:12px">
  <div style="font-weight:600;margin-bottom:8px">Review Information</div>

  <div><strong>Date:</strong> ${safe(createdAt)}</div>
  ${authorName ? `<div><strong>Customer:</strong> ${safe(authorName)}</div>` : ""}
  ${provider ? `<div><strong>Provider:</strong> ${safe(provider)}</div>` : ""}
  <div><strong>Location:</strong> ${safe(locationName)} (${safe(locationId)})</div>
  <div><strong>Rating:</strong> ${stars(rating)}</div>
  <div><strong>Comment:</strong><br>${safe(text || "(no text)")}</div>
  ${publicUrl ? `<div style="margin-top:8px"><a href="${safe(publicUrl)}" target="_blank" rel="noopener">View in Chatmeter</a></div>` : ""}
  <div style="margin-top:10px;color:#6b7280;font-style:italic">
    The first public comment on this ticket will be posted to Chatmeter.
  </div>
</div>
`;

  // --- build custom fields
  const custom_fields = [];
  if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
  if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) });
  if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
  if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
  if (ZD_FIELD_LOCATION_NAME)    custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME,    value: String(locationName) });

  const tags = ["chatmeter", "review"];
  if (provider) tags.push(provider.toLowerCase());

  // --- create ticket (one PRIVATE HTML note)
  const createPayload = {
    ticket: {
      subject,
      external_id: externalId,
      requester: { name: "reviews@drivo.com", email: "reviews@drivo.com" },
      comment: { html_body: cardHtml, public: false },
      custom_fields,
      tags
    }
  };

  try {
    const crt = await zdFetch(`/api/v2/tickets.json`, { method: "POST", body: JSON.stringify(createPayload) });
    const txt = await crt.text();
    if (!crt.ok) return res.status(502).send(`Zendesk create error: ${crt.status} ${txt}`);
    const j = JSON.parse(txt);
    const tid = j?.ticket?.id;
    return res.status(200).json({ ok: true, action: "created", id: tid, externalId });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

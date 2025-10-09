// api/review-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID  = process.env.ZD_FIELD_REVIEW_ID;        // 35430266638231
  const F_LOCATION_ID= process.env.ZD_FIELD_LOCATION_ID;      // 35440761054615
  const F_RATING     = process.env.ZD_FIELD_RATING;           // 35440783828759
  const F_FIRST_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // 35430318419351
  const F_LOC_NAME   = process.env.ZD_FIELD_LOCATION_NAME;    // optional text/dropdown

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId;
    if (!reviewId) return res.status(400).send("Missing review id");
    const locationId   = body.locationId || "";
    const locationName = body.locationName || "";
    const rating       = body.rating ?? 0;
    const authorName   = body.authorName || "Chatmeter Reviewer";
    const createdAt    = body.createdAt || "";
    const text         = (body.text || "").trim();
    const publicUrl    = body.publicUrl || body.portalUrl || "";

    const subject = `${locationName || "Location"} – ${rating}★ – ${authorName}`;
    const htmlNote = `
      <p><strong>Review Information</strong></p>
      <p><strong>Date:</strong> ${escapeHtml(createdAt) || "-"}</p>
      <p><strong>Customer:</strong> ${escapeHtml(authorName)}</p>
      <p><strong>Location:</strong> ${escapeHtml(locationName)} (${escapeHtml(locationId)})</p>
      <p><strong>Rating:</strong> ${"★".repeat(Math.max(0, Math.min(5, +rating || 0)))}</p>
      <p><strong>Comment:</strong> ${escapeHtml(text) || "(no text)"}</p>
      ${publicUrl ? `<p><a href="${escapeUrl(publicUrl)}" target="_blank">View in Chatmeter</a></p>` : ""}
      <p><em>The first public comment on this ticket will be posted to Chatmeter.</em></p>
    `.replace(/\n\s+/g, " ").trim();

    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

    // 1) Find existing ticket by external_id (dedupe)
    const searchQ = encodeURIComponent(`type:ticket external_id:${reviewId}`);
    const sr = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=${searchQ}`, {
      headers: { Authorization: auth }
    });
    const sdata = await sr.json().catch(() => ({}));
    const existing = Array.isArray(sdata?.results) ? sdata.results.find(t => t?.external_id == reviewId) : null;

    // Build custom fields
    const custom_fields = [];
    if (F_REVIEW_ID)  custom_fields.push({ id: +F_REVIEW_ID,  value: String(reviewId) });
    if (F_LOCATION_ID)custom_fields.push({ id: +F_LOCATION_ID, value: String(locationId || "") });
    if (F_RATING)     custom_fields.push({ id: +F_RATING,     value: +rating || 0 });
    if (F_FIRST_SENT) custom_fields.push({ id: +F_FIRST_SENT, value: false });
    if (F_LOC_NAME && locationName) {
      // Works for text field and for dropdown (Zendesk will validate tag)
      custom_fields.push({ id: +F_LOC_NAME, value: String(locationName) });
    }

    // 2) Create or update
    if (existing) {
      // Update fields & tags only (no new comment)
      const upd = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${existing.id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          ticket: {
            custom_fields,
            tags: Array.from(new Set([...(existing.tags || []), "chatmeter", "review", "inbound"])),
          }
        })
      });
      if (!upd.ok) {
        const t = await upd.text();
        return res.status(207).json({ ok: true, warn: `Updated fields only; comment skipped`, details: t });
      }
      return res.status(200).json({ ok: true, updatedTicketId: existing.id, dedup: true });
    }

    // Create with one internal note
    const createPayload = {
      ticket: {
        subject,
        external_id: String(reviewId),
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound"],
        custom_fields,
        comment: { html_body: htmlNote, public: false }
      }
    };

    const cr = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(createPayload)
    });

    if (!cr.ok) {
      const et = await cr.text();
      return res.status(502).send(`Zendesk create error: ${cr.status} ${et}`);
    }
    const c = await cr.json();
    return res.status(200).json({ ok: true, createdTicketId: c?.ticket?.id || null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
}
function escapeUrl(s) { return String(s || "").replace(/"/g, "%22"); }

// /api/review-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Zendesk creds/fields
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID  = process.env.ZD_FIELD_REVIEW_ID;
  const F_LOCATION_ID= process.env.ZD_FIELD_LOCATION_ID;
  const F_RATING     = process.env.ZD_FIELD_RATING;
  const F_FIRST_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;
  const F_LOC_NAME   = process.env.ZD_FIELD_LOCATION_NAME; // optional

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !F_REVIEW_ID  && "ZD_FIELD_REVIEW_ID",
    !F_LOCATION_ID&& "ZD_FIELD_LOCATION_ID",
    !F_RATING     && "ZD_FIELD_RATING",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      id, provider, locationId, locationName,
      rating, authorName, createdAt, text, publicUrl
    } = body;

    if (!id) return res.status(400).send("Missing review id");

    // subject “JFK – 5★ – Reviewer”
    const subject = `${locationName || "Location"} – ${rating || 0}★ – ${authorName || "Reviewer"}`;

    // internal “Review Information” block
    const internalNote = formatInternalNote({
      createdAt, authorName, provider, locationId, locationName, rating, text, publicUrl
    });

    const external_id = `chatmeter:${id}`;
    const custom_fields = [
      { id: +F_REVIEW_ID,   value: String(id) },
      { id: +F_LOCATION_ID, value: String(locationId || "") },
      { id: +F_RATING,      value: Number(rating || 0) },
    ];
    if (F_FIRST_SENT) custom_fields.push({ id: +F_FIRST_SENT, value: false });
    if (F_LOC_NAME && locationName) custom_fields.push({ id: +F_LOC_NAME, value: String(locationName) });

    const ticket = {
      ticket: {
        subject,
        external_id,                        // for dedupe
        requester: { name: "reviews@drivo.com", email: "reviews@drivo.com" },
        comment: { body: internalNote, public: false }, // INTERNAL
        custom_fields,
        tags: [
          "chatmeter",
          (provider || "").toLowerCase() || "unknown",
          `cmrvw_${id}`
        ]
      }
    };

    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const url  = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;
    const r    = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body: JSON.stringify(ticket)
    });
    const txt  = await r.text();

    if (!r.ok) {
      // if duplicate (external_id), update internal note instead of failing
      if (r.status === 422 && /External id has already been taken/i.test(txt)) {
        const tid = await findTicketIdByExternalId(ZD_SUBDOMAIN, auth, external_id);
        if (!tid) return res.status(200).json({ ok: true, action: "noop-dup" });
        await addInternalNote(ZD_SUBDOMAIN, auth, tid, internalNote);
        return res.status(200).json({ ok: true, action: "updated", id: tid });
      }
      return res.status(502).send(`Zendesk error: ${r.status} ${txt}`);
    }

    const data = JSON.parse(txt);
    return res.status(200).json({ ok: true, action: "created", id: data?.ticket?.id, externalId: external_id });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

function formatInternalNote(p) {
  const stars = typeof p.rating === "number" && p.rating > 0
    ? "★".repeat(Math.min(5, p.rating))
    : "★".repeat(Number(p.rating || 0));

  const lines = [
    "Review Information",
    "",
    `Date: ${p.createdAt || "(unknown)"}`,
    p.authorName ? `Customer: ${p.authorName}` : null,
    p.provider   ? `Provider: ${p.provider}`   : null,
    `Location: ${p.locationName || "Unknown"} (${p.locationId || "-"})`,
    `Rating: ${stars || "(none)"}`,
    "",
    "Comment:",
    (p.text && String(p.text).trim()) ? String(p.text).trim() : "(no text)",
    "",
    p.publicUrl ? "View in Chatmeter" : null
  ].filter(Boolean);
  return lines.join("\n");
}

async function findTicketIdByExternalId(sub, auth, external_id) {
  const qs = new URLSearchParams({ query: `type:ticket external_id:"${external_id}"` });
  const u  = `https://${sub}.zendesk.com/api/v2/search.json?${qs.toString()}`;
  const r  = await fetch(u, { headers: { Authorization: "Basic " + auth }});
  const j  = await r.json().catch(()=>({}));
  const hit = (j?.results || []).find(x => x?.external_id === external_id);
  return hit?.id || null;
}

async function addInternalNote(sub, auth, ticketId, body) {
  const u = `https://${sub}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const payload = { ticket: { comment: { body, public: false } } };
  await fetch(u, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + auth },
    body: JSON.stringify(payload)
  });
}

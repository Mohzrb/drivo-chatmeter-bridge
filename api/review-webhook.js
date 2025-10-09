// api/review-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID  = process.env.ZD_FIELD_REVIEW_ID;
  const F_LOCATIONID = process.env.ZD_FIELD_LOCATION_ID;
  const F_RATING     = process.env.ZD_FIELD_RATING;
  const F_FIRST_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;
  const F_LOCNAME    = process.env.ZD_FIELD_LOCATION_NAME; // optional text field for “JFK/EWR/…”

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId    = b.id || b.reviewId;
    const locationId  = b.locationId || "";
    const locationLbl = b.locationName || "";   // << human name from poller
    const rating      = Number(b.rating || 0);
    const authorName  = b.authorName || "Reviewer";
    const createdAt   = b.createdAt || "";
    const text        = (b.text || "").trim();
    const publicUrl   = b.publicUrl || "";

    if (!reviewId) return res.status(400).send("Missing review id");

    // Subject uses human label (e.g., “JFK”) instead of numeric reference
    const subject = `${locationLbl || "Location"} – ${rating}★ – ${authorName}`;

    const bodyLines = [
      `Review ID: ${reviewId}`,
      `Location: ${locationLbl || "(unknown)"}${locationId ? ` (${locationId})` : ""}`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : ""
    ].filter(Boolean);

    const ticket = {
      ticket: {
        subject,
        comment: { body: bodyLines.join("\n"), public: true },   // first comment is public reply body
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter","review","inbound"]
      }
    };

    const custom_fields = [];
    if (F_REVIEW_ID)  custom_fields.push({ id:+F_REVIEW_ID,  value:String(reviewId) });
    if (F_LOCATIONID) custom_fields.push({ id:+F_LOCATIONID, value:String(locationId) });
    if (F_RATING)     custom_fields.push({ id:+F_RATING,     value:rating });
    if (F_FIRST_SENT) custom_fields.push({ id:+F_FIRST_SENT, value:false });
    if (F_LOCNAME)    custom_fields.push({ id:+F_LOCNAME,    value:locationLbl || "" });
    if (custom_fields.length) ticket.ticket.custom_fields = custom_fields;

    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zd = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":"Basic "+auth },
      body: JSON.stringify(ticket)
    });

    if (!zd.ok) return res.status(502).send(`Zendesk error: ${zd.status} ${await zd.text()}`);

    const data = await zd.json();
    return res.status(200).json({ ok:true, createdTicketId: data?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
}

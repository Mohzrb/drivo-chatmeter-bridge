// Chatmeter → Zendesk (create ticket)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL,
    ZENDESK_API_TOKEN,
    ZD_FIELD_REVIEW_ID,
    ZD_FIELD_LOCATION_ID,
    ZD_FIELD_RATING,
    ZD_FIELD_FIRST_REPLY_SENT,
    ZD_FIELD_LOCATION_NAME,       // optional
    CHM_LOCATION_MAP              // optional JSON mapping { "1001":"JFK", ... }
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN"
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const auth = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // canonical payload we expect:
    // { id, locationId, locationName, rating, authorName, createdAt, text, publicUrl, portalUrl, provider }
    const reviewId     = String(body.id || body.reviewId || "");
    const locationId   = body.locationId ? String(body.locationId) : "";
    const rating       = typeof body.rating === "number" ? body.rating : Number(body.rating || 0);
    const authorName   = body.authorName || "Chatmeter Reviewer";
    const createdAt    = body.createdAt || "";
    const publicUrl    = body.publicUrl || body.reviewURL || "";
    const portalUrl    = body.portalUrl || "";
    const provider     = (body.provider || "").toUpperCase();

    // Location name preference: explicit payload → mapping → fallback
    let map = {};
    try { map = CHM_LOCATION_MAP ? JSON.parse(CHM_LOCATION_MAP) : {}; } catch {}
    const mappedName = map[locationId] || null;
    const locationName = body.locationName || mappedName || "Unknown";

    // Human friendly subject
    const subject = `${locationName} – ${rating}★ – ${authorName}`;

    // Ticket body
    const description = [
      "Update from Chatmeter bridge",
      "",
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "N/A"}`,
      `Location: ${locationName}${locationId ? "" : ""}`,
      `Rating: ${rating || "N/A"}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      (body.text && String(body.text).trim()) ? String(body.text).trim() : "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : "",
      portalUrl ? `Chatmeter URL: ${portalUrl}` : ""
    ].filter(Boolean).join("\n");

    const ticket = {
      ticket: {
        subject,
        // creation message = internal note (like your “Google 5-Star Review” layout)
        comment: { body: description, public: false },
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound", provider.toLowerCase()].filter(Boolean)
      }
    };

    // custom fields
    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID, value: reviewId });
    if (ZD_FIELD_LOCATION_ID && locationId) custom_fields.push({ id: +ZD_FIELD_LOCATION_ID, value: locationId });
    if (ZD_FIELD_RATING && rating) custom_fields.push({ id: +ZD_FIELD_RATING, value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locationName && !mappedName) {
      // If you want to store the friendly name (JFK/EWR/…), set this field id
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    }
    if (custom_fields.length) ticket.ticket.custom_fields = custom_fields;

    const zdRes = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify(ticket)
    });

    if (!zdRes.ok) {
      const errTxt = await zdRes.text();
      return res.status(502).send(`Zendesk error: ${zdRes.status} ${errTxt}`);
    }

    const data = await zdRes.json();
    res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null });
  } catch (e) {
    res.status(500).send(`Error: ${e?.message || e}`);
  }
}

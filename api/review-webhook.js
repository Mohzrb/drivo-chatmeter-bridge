export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // required for dedupe
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID || "";
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING || "";
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT || "";

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId = body.id || body.reviewId || body.review_id || "";
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = body.locationId ?? "";
    const locationName = body.locationName ?? "Unknown Location";
    const rating       = body.rating ?? 0;
    const authorName   = body.authorName ?? "Chatmeter Reviewer";
    const createdAt    = body.createdAt || body.reviewDate || "";
    const text         = body.text ?? "";
    const publicUrl    = body.publicUrl ?? "";
    const portalUrl    = body.portalUrl ?? "";

    // --- DEDUPE: search for existing ticket with this custom field value ---
    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const q = encodeURIComponent(`type:ticket custom_field_${ZD_FIELD_REVIEW_ID}:"${reviewId}"`);
    const searchRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=${q}`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (!searchRes.ok) {
      const t = await searchRes.text();
      return res.status(502).send(`Zendesk search error: ${searchRes.status} ${t}`);
    }
    const searchJson = await searchRes.json();
    const existing = (searchJson.results || []).find(r => r && r.id);

    if (existing) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        existingTicketId: existing.id
      });
    }
    // ----------------------------------------------------------------------

    const subject = `${locationName} – ${rating}★ – ${authorName}`;
    const description = [
      `Review ID: ${reviewId}`,
      `Location: ${locationName} (${locationId})`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : "",
      portalUrl ? `Chatmeter URL: ${portalUrl}` : ""
    ].filter(Boolean).join("\n");

    const ticket = {
      ticket: {
        subject,
        comment: { body: description, public: true },
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound"],
        custom_fields: [
          { id: +ZD_FIELD_REVIEW_ID, value: String(reviewId) },
          ...(ZD_FIELD_LOCATION_ID      ? [{ id: +ZD_FIELD_LOCATION_ID, value: String(locationId) }] : []),
          ...(ZD_FIELD_RATING           ? [{ id: +ZD_FIELD_RATING, value: rating }] : []),
          ...(ZD_FIELD_FIRST_REPLY_SENT ? [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false }] : []),
        ]
      }
    };

    const createRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(ticket)
    });

    if (!createRes.ok) {
      const t = await createRes.text();
      return res.status(502).send(`Zendesk create error: ${createRes.status} ${t}`);
    }

    const data = await createRes.json();
    return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null, deduped: false });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

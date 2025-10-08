// api/review-webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // optional text/dropdown

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).send(`Missing env: ${missing.join(", ")}`);
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId || body.review_id;
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = body.locationId ?? "";
    const locationName = body.locationName ?? "Unknown";
    const rating       = body.rating ?? 0;
    const authorName   = body.authorName ?? "Chatmeter Reviewer";
    const createdAt    = body.createdAt ?? "";
    const text         = body.text ?? body.comment ?? body.reviewText ?? "";
    const publicUrl    = body.publicUrl ?? body.reviewURL ?? "";
    const provider     = body.provider ?? body.contentProvider ?? "";
    const extId        = `chatmeter:${reviewId}`;

    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

    // 1) DEDUPE: check if a ticket already exists for this review
    const chk = await fetch(
      `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(extId)}`,
      { headers: { Authorization: auth } }
    );

    if (chk.ok) {
      const cj = await chk.json();
      const existing = (cj.tickets && cj.tickets[0]) || null;
      if (existing) {
        // Update existing (internal note + refresh custom fields)
        const custom_fields = [];
        if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
        if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) });
        if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
        if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
        if (ZD_FIELD_LOCATION_NAME && locationName) {
          custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
        }

        const upd = await fetch(
          `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${existing.id}.json`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({
              ticket: {
                comment: {
                  body: `Chatmeter update received (dedupe). Provider: ${provider || "N/A"}`,
                  public: false
                },
                custom_fields,
                tags: ["chatmeter", "review", "deduped"]
              }
            })
          }
        );

        if (!upd.ok) {
          const et = await upd.text();
          return res.status(207).send(`Found existing ticket but update failed: ${upd.status} ${et}`);
        }

        return res.status(200).json({ ok: true, deduped: true, ticketId: existing.id });
      }
    }

    // 2) CREATE new ticket
    const subject = `${locationName} – ${rating}★ – ${authorName}`;
    const description = [
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "N/A"}`,
      `Location: ${locationName} (${locationId})`,
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
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locationName) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    }

    const create = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        ticket: {
          external_id: extId,                              // <- key for de-dupe
          subject,
          comment: { body: description, public: true },    // first message public
          requester: { name: authorName, email: "reviews@drivo.com" },
          custom_fields,
          tags: ["chatmeter", "review", provider.toLowerCase()].filter(Boolean)
        }
      })
    });

    const data = await create.json();
    if (!create.ok) {
      return res.status(502).send(`Zendesk create error: ${create.status} ${JSON.stringify(data)}`);
    }

    return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

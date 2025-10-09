// Chatmeter → Zendesk (create ticket with internal "Review Information" note)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // --- env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;   // e.g., drivohelp
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text/number
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // (optional) text/tagger

  const CHM_LOCATION_MAP_JSON = process.env.CHM_LOCATION_MAP || "";        // {"1001892551":"JFK",...}

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // payload from poller or direct webhook
    const reviewId     = body.id || body.reviewId || "";
    const locationId   = body.locationId ?? "";
    const locationName = body.locationName ?? "";
    const rating       = body.rating ?? 0;
    const authorName   = body.authorName ?? "Reviewer";
    const createdAt    = body.createdAt ?? "";
    const provider     = (body.provider || "").toUpperCase();
    const text         = body.text ?? "";
    const publicUrl    = body.publicUrl ?? body.portalUrl ?? "";

    if (!reviewId) return res.status(400).send("Missing review id");

    // Location map label (JFK/EWR/BRK…)
    let LOC_MAP = {};
    try { if (CHM_LOCATION_MAP_JSON) LOC_MAP = JSON.parse(CHM_LOCATION_MAP_JSON); } catch {}
    const locLabel = LOC_MAP[locationId] || locationName || "Unknown";

    // Subject (e.g., "JFK – 5★ – Reviewer")
    const subject = `${locLabel} – ${rating}★ – ${authorName}`;

    // Internal "Review Information" note
    const lines = [];
    lines.push("Review Information:");
    lines.push("");
    if (createdAt) lines.push(`Date: ${createdAt}`);
    lines.push("");
    lines.push(`Customer: ${authorName}`);
    if (body.reviewerEmail) lines.push(body.reviewerEmail);
    if (body.reviewerPhone) lines.push(body.reviewerPhone);
    lines.push("");
    lines.push(`Location: ${locLabel}${locationId ? ` (${locationId})` : ""}`);
    lines.push("");
    lines.push("Comment:");
    lines.push(text || "(no text)");
    lines.push("");
    if (publicUrl) {
      lines.push("Public URL:");
      lines.push(publicUrl);
    }
    const internalNote = lines.join("\n");

    // Build ticket
    const ticket = {
      ticket: {
        subject,
        requester: {
          name: "reviews@drivo.com",
          email: "reviews@drivo.com"   // requester fixed
        },
        comment: {
          body: internalNote,
          public: false                // make the first note INTERNAL
        },
        tags: [
          "chatmeter",
          "review",
          "inbound",
          provider ? provider.toLowerCase() : "unknown_provider"
        ],
        custom_fields: [
          ...(ZD_FIELD_REVIEW_ID        ? [{ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) }] : []),
          ...(ZD_FIELD_LOCATION_ID      ? [{ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) }] : []),
          ...(ZD_FIELD_RATING           ? [{ id: +ZD_FIELD_RATING,           value: Number(rating) }]   : []),
          ...(ZD_FIELD_FIRST_REPLY_SENT ? [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false }]            : []),
          ...(ZD_FIELD_LOCATION_NAME    ? [{ id: +ZD_FIELD_LOCATION_NAME,    value: String(locLabel) }] : []),
        ]
      }
    };

    // Zendesk POST
    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zdRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body: JSON.stringify(ticket)
    });
    const txt = await zdRes.text();
    if (!zdRes.ok) return res.status(502).send(`Zendesk error: ${zdRes.status} ${txt}`);

    const data = JSON.parse(txt);
    return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

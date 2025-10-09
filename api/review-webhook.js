// /api/review-webhook.js
// Chatmeter → Zendesk (create ticket; requester reviews@drivo.com; first message INTERNAL; dedupe by external_id)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---- env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;
  const ZD_AGENT_ID  = Number(process.env.ZD_AGENT_ID || 0);

  const F_REVIEW_ID  = Number(process.env.ZD_FIELD_REVIEW_ID);
  const F_LOC_ID     = Number(process.env.ZD_FIELD_LOCATION_ID);
  const F_RATING     = Number(process.env.ZD_FIELD_RATING);
  const F_FIRST_SENT = Number(process.env.ZD_FIELD_FIRST_REPLY_SENT || 0);
  const F_LOC_NAME   = Number(process.env.ZD_FIELD_LOCATION_NAME || 0); // optional

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_AGENT_ID && "ZD_AGENT_ID",
    !F_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !F_LOC_ID && "ZD_FIELD_LOCATION_ID",
    !F_RATING && "ZD_FIELD_RATING",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const zdFetch = (path, init = {}) =>
    fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "Authorization": auth, ...(init.headers || {}) },
    });

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    // expected keys
    const reviewId     = String(b.id || b.reviewId || "").trim();
    const provider     = b.provider || b.contentProvider || "";
    const rating       = Number(b.rating ?? 0);
    const locationId   = String(b.locationId ?? "");
    const locationName = String(b.locationName ?? "Unknown");
    const createdAt    = b.createdAt || b.reviewDate || "";
    const publicUrl    = b.publicUrl || b.reviewURL || "";
    const authorName   = b.authorName || b.reviewerUserName || "Reviewer";

    // robust text extraction
    let text = (b.text || b.comment || b.reviewText || "").trim();
    if (!text && Array.isArray(b.reviewData)) {
      const first = b.reviewData.find(d =>
        /comment|text|nps_comment|review/i.test(d?.name || "")
      );
      if (first?.value) text = String(first.value).trim();
    }

    if (!reviewId) return res.status(400).send("Missing review id");

    // ---- dedupe (by external_id)
    const extId = `chatmeter:${reviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${extId}"`);
    const r = await zdFetch(`/api/v2/search.json?query=${q}`);
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).send(`Zendesk lookup failed: ${r.status} ${t}`);
    }
    const found = (await r.json())?.results?.[0];
    if (found?.id) {
      return res.status(200).json({ ok: true, deduped: true, ticketId: found.id });
    }

    // ---- internal note (matches the format you like)
    const prettyLoc = locationName || locationId;
    const lines = [
      "Review Information:",
      "",
      `Date: ${createdAt || "(unknown)"}`,
      "",
      `Customer: ${authorName}`,
      "",
      `Location: ${prettyLoc}`,
      "",
      "Comment:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl || "(none)"
    ];
    const note = lines.join("\n");

    // ---- custom_fields
    const cfs = [
      { id: F_REVIEW_ID,  value: reviewId },
      { id: F_LOC_ID,     value: locationId || null },
      { id: F_RATING,     value: rating || null },
    ];
    if (F_FIRST_SENT) cfs.push({ id: F_FIRST_SENT, value: false });
    if (F_LOC_NAME)   cfs.push({ id: F_LOC_NAME,   value: locationName || null });

    // ---- create ticket
    const payload = {
      ticket: {
        subject: `${locationName || locationId} – ${rating || 0}★ – ${authorName}`,
        external_id: extId,
        requester: { name: "reviews@drivo.com", email: "reviews@drivo.com" },  // keep this requester
        comment: { body: note, public: false, author_id: ZD_AGENT_ID },         // force INTERNAL first note
        tags: ["chatmeter", "review", (provider || "unknown").toLowerCase()],
        custom_fields: cfs
      }
    };

    const crt = await zdFetch(`/api/v2/tickets.json`, { method: "POST", body: JSON.stringify(payload) });
    const body = await crt.text();
    if (!crt.ok) return res.status(502).send(`Zendesk create failed: ${crt.status} ${body}`);

    const data = JSON.parse(body);
    return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id || null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

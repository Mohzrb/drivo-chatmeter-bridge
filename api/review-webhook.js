// api/review-webhook.js
// Plain-text beige card (internal) + idempotent create/update

const { createOrUpdateFromChatmeter } = require("./_zd");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

const first = (...v) => v.find(x => x !== undefined && x !== null && String(x).trim() !== "");
const safeJson = (x) => { try { return typeof x === "string" ? JSON.parse(x || "{}") : (x || {}); } catch { return {}; } };

// build the card EXACTLY like your example
function buildCard({ reviewId, provider, locationName, locationId, rating, reviewDate, text, publicUrl }) {
  const lines = [
    `Review ID: ${reviewId}`,
    `Provider: ${provider}`,
    `Location: ${locationName} (${locationId ?? "N/A"})`,
    `Rating: ${rating ?? "N/A"}★`,
    `Date: ${reviewDate ?? "N/A"}`,
    `Review Text:`,
    ``,
    text ? String(text) : `(no text)`,
    ``,
    `Public URL:`,
    publicUrl || ``,
  ];
  return lines.join("\n");
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.test === "1"))
      return res.status(200).json({ ok: true, msg: "webhook alive" });

    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const p = safeJson(req.body);

    const reviewId     = first(p.reviewId, p.review_id, p.id, p.review?.id, p.payload?.review_id);
    if (!reviewId) return res.status(400).json({ error: "Missing reviewId" });

    const rating       = first(p.rating, p.stars, p.review?.rating, p.payload?.rating);
    const locationId   = first(p.locationId, p.location_id, p.review?.location_id, p.payload?.location_id);
    const locationName = first(p.locationName, p.location, p.review?.location_name, p.payload?.location_name, "Location");
    const provider     = first(p.provider, p.source, p.review?.provider, p.payload?.provider, "Provider");
    const publicUrl    = first(p.publicUrl, p.public_url, p.url, p.link, p.review?.public_url, p.review?.url, p.payload?.public_url);
    const reviewDate   = first(p.date, p.review_date, p.created_at, p.createdAt, p.review?.date, p.review?.created_at, p.payload?.review_date);
    const author       = first(p.author, p.reviewer, p.review?.author, p.payload?.author, p.reviewer_name, "Reviewer");
    const text         = first(
      p.text, p.comment, p.content, p.body, p.message, p.snippet, p.description,
      p.review?.text, p.review?.comment, p.review?.content, p.review?.body, p.review?.message, p.review?.review_text,
      p.payload?.text, p.payload?.comment, p.payload?.content, p.payload?.body, p.payload?.message, p.payload?.review_text
    );

    const subject = `${locationName} – ${rating ?? "?"}★ – ${author}`;
    const body    = buildCard({ reviewId, provider, locationName, locationId, rating, reviewDate, text, publicUrl });

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,                     // ← plain text (Zendesk renders beige internal note)
      requester: "reviews@drivo.com",
      tags: ["chatmeter","review","google"],
      customFields,
      isPublic: false           // internal
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

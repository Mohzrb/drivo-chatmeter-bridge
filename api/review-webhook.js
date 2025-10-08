// api/review-webhook.js
// Plain-text beige card (internal note) + idempotent create/update

const { createOrUpdateFromChatmeter } = require("./_zd");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

const first = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== "");
const safeJson = (x) => { try { return typeof x === "string" ? JSON.parse(x || "{}") : (x || {}); } catch { return {}; } };

module.exports = async (req, res) => {
  try {
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.test === "1"))
      return res.status(200).json({ ok: true, msg: "webhook alive" });

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const payload = safeJson(req.body);

    // Normalize fields
    const reviewId = first(payload.reviewId, payload.review_id, payload.id, payload.review?.id, payload.payload?.review_id);
    if (!reviewId) return res.status(400).json({ error: "Missing reviewId" });

    const rating       = first(payload.rating, payload.stars, payload.review?.rating, payload.payload?.rating);
    const locationId   = first(payload.locationId, payload.location_id, payload.review?.location_id, payload.payload?.location_id);
    const locationName = first(payload.locationName, payload.location, payload.review?.location_name, payload.payload?.location_name, "Location");
    const provider     = first(payload.provider, payload.source, payload.review?.provider, payload.payload?.provider, "Provider");
    const publicUrl    = first(payload.publicUrl, payload.public_url, payload.url, payload.link, payload.review?.public_url, payload.review?.url, payload.payload?.public_url);
    const reviewDate   = first(payload.date, payload.review_date, payload.created_at, payload.createdAt, payload.review?.date, payload.review?.created_at, payload.payload?.review_date);
    const author       = first(payload.author, payload.reviewer, payload.review?.author, payload.payload?.author, payload.reviewer_name, "Reviewer");

    // Robust text extraction
    const text = first(
      payload.text, payload.comment, payload.content, payload.body, payload.message, payload.snippet, payload.description,
      payload.review?.text, payload.review?.comment, payload.review?.content, payload.review?.body, payload.review?.message, payload.review?.review_text,
      payload.payload?.text, payload.payload?.comment, payload.payload?.content, payload.payload?.body, payload.payload?.message, payload.payload?.review_text
    );

    // Subject
    const subject = `${locationName} – ${rating ?? "?"}★ – ${author}`;

    // ********  PLAIN-TEXT beige card (matches your screenshot)  ********
    const lines = [
      `Review ID: ${reviewId}`,
      `Provider: ${provider}`,
      `Location: ${locationName} (${locationId ?? "N/A"})`,
      `Rating: ${rating ?? "N/A"}★`,
      `Date: ${reviewDate ?? "N/A"}`,
      `Review Text:`,
      ``,
      text ? String(text) : `(no text)`
    ];
    if (publicUrl) {
      lines.push(``);
      lines.push(`Public URL:`);
      lines.push(publicUrl);
    }
    const body = lines.join("\n");
    // *******************************************************************

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,                     // plain text -> beige internal note
      requester: "reviews@drivo.com",
      tags: ["chatmeter","review","google"],
      customFields,
      isPublic: false           // keep as Internal
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

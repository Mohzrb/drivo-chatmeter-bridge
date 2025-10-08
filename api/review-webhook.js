// api/review-webhook.js
// Chatmeter → Zendesk webhook: idempotent upsert (no duplicate tickets)

const { createOrUpdateFromChatmeter } = require("./_zd");

// Custom ticket field IDs from env (must be numeric IDs from Zendesk)
const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;
const F_FIRST_RSP = process.env.ZD_FIELD_FIRST_REPLY_SENT || null;

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const payload = readBody(req);

    // normalize fields from different Chatmeter shapes
    const reviewId =
      payload.reviewId || payload.review_id || payload.id || payload.review?.id || payload.payload?.review_id;

    if (!reviewId) return res.status(400).json({ error: "Missing reviewId", got: payload });

    const rating =
      payload.rating || payload.review?.rating || payload.payload?.rating || payload.stars;

    const locationId =
      payload.locationId || payload.location_id || payload.review?.location_id || payload.payload?.location_id;

    const locationName =
      payload.locationName || payload.location || payload.review?.location_name || payload.payload?.location_name || "Location";

    const author =
      payload.author || payload.reviewer || payload.review?.author || payload.payload?.author || payload.reviewer_name || "Reviewer";

    const text =
      payload.text || payload.comment || payload.content || payload.review?.text || payload.payload?.text || "";

    const subject = `${locationName} – ${rating ?? "?"}★ – ${author}`;
    const body =
      `Rating: ${rating ?? "N/A"} | Location: ${locationId ?? "N/A"}\n` +
      (text ? `\n${text}` : "");

    // Optional DRY RUN: ?dry=1 will not touch Zendesk, returns what would be sent
    if (req.query && (req.query.dry === "1" || req.query.test === "1")) {
      return res.status(200).json({
        dryRun: true,
        wouldSend: {
          reviewId,
          subject,
          body,
          tags: ["chatmeter", "review", "google", `cmrvw_${reviewId}`],
          external_id: `chatmeter:${reviewId}`,
          custom_fields: [
            ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
            ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
            ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
          ],
        },
      });
    }

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
      // F_FIRST_RSP could be set later by a trigger when an agent replies
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,
      requester: "reviews@drivo.com",
      tags: ["chatmeter", "review", "google"],
      customFields,
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.toString?.() || "unknown_error";
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

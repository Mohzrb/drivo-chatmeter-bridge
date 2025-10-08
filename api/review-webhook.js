// api/review-webhook.js
const { createOrUpdateFromChatmeter } = require("./_zd");

const CHATMETER_REVIEW_ID_FIELD = process.env.ZD_CHATMETER_REVIEW_ID_FIELD || null;

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const payload = readBody(req);

    // Normalize fields (accept a variety of payload shapes)
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

    // ---------- DRY RUN: skip Zendesk, just tell us what would happen ----------
    if (req.query && (req.query.dry === "1" || req.query.test === "1")) {
      return res.status(200).json({
        dryRun: true,
        wouldSend: {
          reviewId,
          subject,
          body,
          tags: ["chatmeter", "review", "google", `cmrvw_${reviewId}`],
          external_id: `chatmeter:${reviewId}`,
          customFieldId: CHATMETER_REVIEW_ID_FIELD || undefined,
        },
      });
    }
    // ---------------------------------------------------------------------------

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,
      requester: "reviews@drivo.com",
      tags: ["chatmeter", "review", "google"],
      customFieldId: CHATMETER_REVIEW_ID_FIELD || undefined,
    });

    return res.status(200).json(result);
  } catch (e) {
    // Return detailed, but safe, error info to help us debug quickly
    const detail =
      e?.response?.data ||
      e?.message ||
      e?.toString?.() ||
      "unknown_error";
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

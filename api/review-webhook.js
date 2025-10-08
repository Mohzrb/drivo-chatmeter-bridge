// api/review-webhook.js
// Chatmeter → Zendesk webhook: idempotent upsert (no duplicate tickets)

const { createOrUpdateFromChatmeter } = require("./_zd");

// OPTIONAL: if you created a custom ticket field "Chatmeter Review ID", put its numeric id here
const CHATMETER_REVIEW_ID_FIELD = process.env.ZD_CHATMETER_REVIEW_ID_FIELD || null;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Be liberal in reading keys—covers different Chatmeter payload shapes
    const reviewId =
      payload.reviewId ||
      payload.review_id ||
      payload.id ||
      payload.review?.id ||
      payload.payload?.review_id;

    if (!reviewId) {
      return res.status(400).json({ error: "Missing reviewId" });
    }

    const rating =
      payload.rating ||
      payload.review?.rating ||
      payload.payload?.rating ||
      payload.stars;

    const locationId =
      payload.locationId ||
      payload.location_id ||
      payload.review?.location_id ||
      payload.payload?.location_id;

    const locationName =
      payload.locationName ||
      payload.location ||
      payload.review?.location_name ||
      payload.payload?.location_name ||
      "Location";

    const author =
      payload.author ||
      payload.reviewer ||
      payload.review?.author ||
      payload.payload?.author ||
      payload.reviewer_name ||
      "Reviewer";

    const text =
      payload.text ||
      payload.comment ||
      payload.content ||
      payload.review?.text ||
      payload.payload?.text ||
      "";

    const subject = `${locationName} – ${rating ?? "?"}★ – ${author}`;
    const body =
      `Rating: ${rating ?? "N/A"} | Location: ${locationId ?? "N/A"}\n` +
      (text ? `\n${text}` : "");

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,
      requester: "reviews@drivo.com",
      tags: ["chatmeter", "review", "google"], // keep your style
      customFieldId: CHATMETER_REVIEW_ID_FIELD || undefined,
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error("review-webhook error:", e?.response?.data || e.message || e);
    return res.status(500).json({ error: "zendesk_upsert_failed" });
  }
};

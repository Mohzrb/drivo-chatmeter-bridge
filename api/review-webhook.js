// api/review-webhook.js
const { createOrUpdateFromChatmeter } = require("./_zd");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

// minimal safe reader
function safeBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body;
  } catch (e) {
    // return raw in case parse failed
    return { _raw: req.body, _parseError: e?.message || String(e) };
  }
}

module.exports = async (req, res) => {
  try {
    // quick ping
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.dry === "1" || req.query?.test === "1")) {
      return res.status(200).json({
        ok: true,
        msg: "webhook alive",
        env: {
          SUBDOMAIN: process.env.ZENDESK_SUBDOMAIN || null,
          EMAIL: process.env.ZENDESK_EMAIL || null,
          HAS_TOKEN: !!(process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN)
        }
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // allow dry=1 WITHOUT hitting Zendesk & WITHOUT parsing the body
    if (req.query && (req.query.dry === "1" || req.query.test === "1")) {
      return res.status(200).json({
        dryRun: true,
        ok: true,
        note: "No Zendesk call performed"
      });
    }

    const payload = safeBody(req);

    const reviewId =
      payload.reviewId || payload.review_id || payload.id || payload.review?.id || payload.payload?.review_id;

    if (!reviewId) {
      return res.status(400).json({ error: "Missing reviewId", payload });
    }

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

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body,
      requester: "reviews@drivo.com",
      tags: ["chatmeter", "review", "google"],
      customFields
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

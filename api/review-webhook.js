// api/review-webhook.js
const { createOrUpdateFromChatmeter } = require("./_zd");
const { extract, buildPlainCard } = require("./_card");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

module.exports = async (req, res) => {
  try {
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.test === "1"))
      return res.status(200).json({ ok: true, msg: "webhook alive" });
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { subject, data } = extract(payload);
    if (!data.reviewId) return res.status(400).json({ error: "Missing reviewId" });

    const body = buildPlainCard(data);

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: data.reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(data.locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: data.rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId: data.reviewId,
      subject,
      body,                       // plain text -> beige internal note
      requester: "reviews@drivo.com",
      tags: ["chatmeter","review","google"],
      customFields,
      isPublic: false
    });

    // Debug helper
    if (req.query?.dry === "1") return res.status(200).json({ dryRun: true, subject, body, picked: data });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

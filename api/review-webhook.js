// api/review-webhook.js
// Chatmeter → Zendesk webhook: idempotent upsert (no duplicate tickets)
// Hardened text extraction (Yelp/Google variations) + always include Public URL and Date.

const { createOrUpdateFromChatmeter } = require("./_zd");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

// tiny helpers
const first = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== "");
const safeJson = (x) => {
  try { return typeof x === "string" ? JSON.parse(x || "{}") : (x || {}); }
  catch { return { _raw: x, _parseError: true }; }
};

module.exports = async (req, res) => {
  try {
    // quick ping / dry
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.test === "1")) {
      return res.status(200).json({ ok: true, msg: "webhook alive" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const payload = safeJson(req.body);

    // Normalize IDs/fields from multiple Chatmeter shapes
    const reviewId = first(
      payload.reviewId, payload.review_id, payload.id,
      payload.review?.id, payload.payload?.review_id
    );
    if (!reviewId) return res.status(400).json({ error: "Missing reviewId", got: payload });

    const rating = first(
      payload.rating, payload.stars,
      payload.review?.rating, payload.payload?.rating
    );

    const locationId = first(
      payload.locationId, payload.location_id,
      payload.review?.location_id, payload.payload?.location_id
    );

    const locationName = first(
      payload.locationName, payload.location,
      payload.review?.location_name, payload.payload?.location_name,
      "Location"
    );

    const provider = first(
      payload.provider, payload.source, payload.review?.provider,
      payload.payload?.provider, "Provider"
    );

    const publicUrl = first(
      payload.publicUrl, payload.public_url, payload.url, payload.link,
      payload.review?.public_url, payload.review?.url, payload.payload?.public_url
    );

    const reviewDate = first(
      payload.date, payload.review_date, payload.created_at, payload.createdAt,
      payload.review?.date, payload.review?.created_at, payload.payload?.review_date
    );

    // 🔧 ROBUST TEXT EXTRACTION (covers Yelp/Google/FB shapes)
    const text = first(
      payload.text, payload.comment, payload.content, payload.body, payload.message, payload.snippet, payload.description,
      payload.review?.text, payload.review?.comment, payload.review?.content, payload.review?.body, payload.review?.message, payload.review?.review_text,
      payload.payload?.text, payload.payload?.comment, payload.payload?.content, payload.payload?.body, payload.payload?.message, payload.payload?.review_text
    );

    // Build subject and body (always include URL + Date)
    const subject = `${locationName} – ${rating ?? "?"}★ – ${first(payload.author, payload.reviewer, payload.review?.author, payload.payload?.author, payload.reviewer_name, "Reviewer")}`;

    const lines = [];
    lines.push(`Review ID: ${reviewId}`);
    lines.push(`Provider: ${provider}`);
    lines.push(`Location: ${locationName} (${locationId ?? "N/A"})`);
    lines.push(`Rating: ${rating ?? "N/A"}★`);
    if (reviewDate) lines.push(`Date: ${reviewDate}`);
    lines.push(`Review Text:`);
    lines.push(text ? String(text) : `(no text)`);
    if (publicUrl) lines.push(`Public URL:\n${publicUrl}`);

    const body = lines.join("\n");

    // Optional DRY RUN
    if (req.query && (req.query.dry === "1" || req.query.test === "1")) {
      return res.status(200).json({
        dryRun: true,
        wouldSend: {
          subject, body,
          external_id: `chatmeter:${reviewId}`,
          tags: ["chatmeter","review","google", `cmrvw_${reviewId}`],
          custom_fields: [
            ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
            ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
            ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
          ],
        }
      });
    }

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId,
      subject,
      body, // includes text or explicit "(no text)"
      requester: "reviews@drivo.com",
      tags: ["chatmeter","review","google"],
      customFields
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

// api/review-webhook.js
// Robust extractor -> plain-text beige card (internal) -> idempotent upsert

const { createOrUpdateFromChatmeter } = require("./_zd");

const F_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID || null;
const F_LOCATION  = process.env.ZD_FIELD_LOCATION_ID || null;
const F_RATING    = process.env.ZD_FIELD_RATING || null;

const isNonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== "";

// Lowercase, normalize separators
function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]+/g, "."); }

// Deep-flatten any object/array into { "a.b.c": value }
function flatten(obj, base = "", out = {}) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object") { out[base || ""] = obj; return out; }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, base ? `${base}.${i}` : String(i), out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = base ? `${base}.${normKey(k)}` : normKey(k);
    flatten(v, key, out);
  }
  return out;
}

// Return first non-empty among explicit keys or regexes
function pick(flat, keysOrRegexes) {
  for (const cand of keysOrRegexes) {
    if (cand instanceof RegExp) {
      for (const [k, v] of Object.entries(flat)) if (cand.test(k) && isNonEmpty(v)) return v;
    } else {
      const v = flat[normKey(cand)];
      if (isNonEmpty(v)) return v;
    }
  }
  return undefined;
}

// Extract with many synonyms; fall back to parsing text blobs
function extract(payload) {
  const flat = flatten(payload);

  // Try to read external_id "chatmeter:<id>"
  const externalId = pick(flat, [/external\.?id/]);
  let reviewId =
    pick(flat, [
      /(^|\.)(review\.?id|reviewid)(\.|$)/,
      "review_id", "review.id", "payload.review_id", "id",
    ]) ||
    (typeof externalId === "string" && externalId.startsWith("chatmeter:") ? externalId.slice(10) : undefined);

  // Other fields
  const rating = pick(flat, [/(\.|^)rating(\.|$)/, /(\.|^)stars?(\.|$)/, "review.rating", "payload.rating"]);
  const locationId = pick(flat, [
    /location(\.|_)?id(\.|$)/, /(\.|^)business.*location.*id/,
    "review.location_id", "payload.location_id",
  ]);
  const locationName = pick(flat, [
    /(\.|^)(location(\.|$)|location\.name|location_name|review\.location_name|payload\.location_name)/,
    "location"
  ]);
  const provider = pick(flat, [/(\.|^)provider(\.|$)/, /(\.|^)source(\.|$)/]) || "PROVIDER";
  const publicUrl = pick(flat, [/public.*url/, /(\.|^)url(\.|$)/, /(\.|^)link(\.|$)/, "review.public_url", "review.url"]);
  const reviewDate = pick(flat, [/review.*date/, /created(_|\.|)at/, /^date$/]);
  const author = pick(flat, [/(\.|^)author(\.|$)/, /(\.|^)reviewer(\.|$)/, "review.author", "payload.author"]) || "Reviewer";

  // Review text from many places
  let text = pick(flat, [
    /review.*text/, /(\.|^)text(\.|$)/, /(\.|^)comment(\.|$)/, /(\.|^)content(\.|$)/,
    /(\.|^)body(\.|$)/, /(\.|^)message(\.|$)/, /(\.|^)snippet(\.|$)/, /(\.|^)description(\.|$)/
  ]);

  // Last-resort: parse a blob that already contains our card lines
  if (!isNonEmpty(text)) {
    const blob = pick(flat, [/(\.|^)body(\.|$)/, /(\.|^)message(\.|$)/, /(\.|^)text(\.|$)/]);
    if (typeof blob === "string") {
      const m = /Review Text:\s*([\s\S]*?)(?:\n(?:Public URL|$))/i.exec(blob);
      if (m && isNonEmpty(m[1])) text = m[1].trim();
    }
  }

  // Subject
  const subject = `${locationName || "Location"} – ${isNonEmpty(rating) ? rating : "?"}★ – ${author}`;

  return {
    subject,
    bodyData: { reviewId, provider, locationName, locationId, rating, reviewDate, text, publicUrl },
    flat
  };
}

// Build EXACT beige card (plain text)
function buildCard(d) {
  const lines = [
    `Review ID: ${d.reviewId ?? ""}`.trimEnd(),
    `Provider: ${d.provider ?? ""}`.trimEnd(),
    `Location: ${d.locationName ?? "Location"} (${d.locationId ?? "N/A"})`,
    `Rating: ${isNonEmpty(d.rating) ? d.rating : "N/A"}★`,
    `Date: ${d.reviewDate ?? "N/A"}`,
    `Review Text:`,
    ``,
    isNonEmpty(d.text) ? String(d.text) : `(no text)`,
    ``,
    `Public URL:`,
    d.publicUrl ? String(d.publicUrl) : ``,
  ];
  return lines.join("\n");
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET" && (req.query?.ping === "1" || req.query?.test === "1"))
      return res.status(200).json({ ok: true, msg: "webhook alive" });

    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { subject, bodyData, flat } = extract(payload);

    if (!isNonEmpty(bodyData.reviewId)) {
      if (req.query?.debug === "1") return res.status(400).json({ error: "Missing reviewId", flat });
      return res.status(400).json({ error: "Missing reviewId" });
    }

    const body = buildCard(bodyData);

    if (req.query?.dry === "1" || req.query?.debug === "1") {
      return res.status(200).json({
        dryRun: true,
        subject,
        card: body,
        picked: bodyData,
        sampleKeys: Object.keys(flat).slice(0, 60) // show first 60 keys to inspect shape
      });
    }

    const customFields = [
      ...(F_REVIEW_ID ? [{ id: Number(F_REVIEW_ID), value: bodyData.reviewId }] : []),
      ...(F_LOCATION  ? [{ id: Number(F_LOCATION),  value: String(bodyData.locationId || "") }] : []),
      ...(F_RATING    ? [{ id: Number(F_RATING),    value: bodyData.rating ?? null }] : []),
    ];

    const result = await createOrUpdateFromChatmeter({
      reviewId: bodyData.reviewId,
      subject,
      body,                 // plain text -> beige internal note (see _zd.js default public:false)
      requester: "reviews@drivo.com",
      tags: ["chatmeter","review","google"],
      customFields,
      isPublic: false
    });

    return res.status(200).json(result);
  } catch (e) {
    const detail = e?.response?.data || e?.message || e?.stack || String(e);
    console.error("review-webhook error:", detail);
    return res.status(500).json({ error: "zendesk_upsert_failed", detail });
  }
};

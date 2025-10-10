// /api/_helpers.js
//
// Shared helpers + provider-specific extractors.
// Goal: always return a clean text comment, consistent location name/id,
// and a tidy internal note for Zendesk.

export const VERSION_HELPERS = "helpers-2025-10-10";

/* ---------------- basics ---------------- */
export function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}
export function isBooleanString(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim().toLowerCase();
  return t === "true" || t === "false";
}
export function safeJSON(s, fb = {}) {
  try { return JSON.parse(s); } catch { return fb; }
}
export function stars(n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(v) + "☆".repeat(5 - v);
}
export function normalizeProvider(p) {
  const v = String(p || "").trim().toUpperCase();
  const MAP = {
    "GOOGLE MAPS": "GOOGLE", "GMAPS": "GOOGLE",
    "TRUST PILOT": "TRUSTPILOT",
    "META": "FACEBOOK", "FB": "FACEBOOK",
    "MICROSOFT": "BING", "BING MAPS": "BING",
  };
  return MAP[v] || v;
}

/* ---------------- text heuristics ---------------- */
function looksLikeRating(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;   // 5, 4.0
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;      // 4/5
  if (/^★{1,5}$/.test(t)) return true;              // ★★★★☆
  if (/^nps[:\s]/i.test(t)) return true;            // NPS: 9
  return false;
}

/* ---------------- ReviewBuilder free-text extraction ---------------- */
export function extractRBText(detail) {
  // Chatmeter RB detail often has reviewData/answers (name/question + value/answerText)
  const rows = Array.isArray(detail?.reviewData) ? detail.reviewData
              : Array.isArray(detail?.answers)   ? detail.answers : [];
  if (!rows.length) return "";

  const candidates = [];
  for (const r of rows) {
    const label = (r?.name || r?.question || "").toString();
    const raw   = r?.value ?? r?.answer ?? r?.answerText ?? r?.text ?? null;
    if (!isNonEmptyString(raw)) continue;

    // ignore obvious boolean/rating-ish rows
    const val = String(raw).trim();
    if (isBooleanString(val)) continue;
    if (looksLikeRating(val)) continue;

    const boost = /open|words|comment|describe|feedback/i.test(label) ? 1 : 0;
    candidates.push({ val, boost, len: val.length, key: val.toLowerCase() });
  }
  if (!candidates.length) return "";

  // prefer boosted, then longest, unique
  candidates.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    out.push(c.val);
    seen.add(c.key);
    if (out.length >= 3) break;
  }
  return out.join("\n\n");
}

/* ---------------- generic text fallback (scan any object) ---------------- */
function deepScanForText(obj) {
  let best = "";
  (function scan(o) {
    if (typeof o === "string") {
      const s = o.trim();
      if (!s) return;
      // ignore URLs and timestamps
      if (/^https?:\/\//i.test(s)) return;
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return;
      if (isBooleanString(s)) return;
      if (looksLikeRating(s)) return;
      if (s.length > best.length) best = s;
      return;
    }
    if (Array.isArray(o)) { for (const x of o) scan(x); return; }
    if (o && typeof o === "object") { for (const x of Object.values(o)) scan(x); }
  })(obj);
  return best;
}

/* ---------------- provider adapters ---------------- */
function extractReviewBuilder(detail, envMap) {
  const comment =
    extractRBText(detail) ||
    detail?.comment || detail?.reviewText || detail?.text || "";

  return {
    provider: "REVIEWBUILDER",
    authorName: detail?.reviewerUserName || detail?.customerName || "Anonymous",
    comment: isNonEmptyString(comment) ? comment.trim() : "(no text)",
    rating: Number(detail?.rating || 0),
    locationId: String(detail?.locationId || ""),
    locationName: envMap[String(detail?.locationId)] || detail?.locationName || "Unknown",
    publicUrl: detail?.reviewURL || detail?.publicUrl || detail?.portalUrl || "",
    createdAt: detail?.reviewDate || detail?.createdAt || new Date().toISOString(),
  };
}

function extractYelp(detail, envMap) {
  const comment = detail?.comment || detail?.text || detail?.reviewText || deepScanForText(detail);
  return {
    provider: "YELP",
    authorName: detail?.reviewerUserName || detail?.customerName || detail?.author || "Anonymous",
    comment: isNonEmptyString(comment) ? comment.trim() : "(no text)",
    rating: Number(detail?.rating || 0),
    locationId: String(detail?.locationId || ""),
    locationName: envMap[String(detail?.locationId)] || detail?.locationName || "Unknown",
    publicUrl: detail?.reviewURL || detail?.publicUrl || detail?.portalUrl || "",
    createdAt: detail?.reviewDate || detail?.createdAt || new Date().toISOString(),
  };
}

function extractGoogle(detail, envMap) {
  const comment = detail?.text || detail?.comment || detail?.reviewText || deepScanForText(detail);
  return {
    provider: "GOOGLE",
    authorName: detail?.reviewerUserName || detail?.customerName || detail?.author || "Anonymous",
    comment: isNonEmptyString(comment) ? comment.trim() : "(no text)",
    rating: Number(detail?.rating || 0),
    locationId: String(detail?.locationId || ""),
    locationName: envMap[String(detail?.locationId)] || detail?.locationName || "Unknown",
    publicUrl: detail?.reviewURL || detail?.publicUrl || detail?.portalUrl || "",
    createdAt: detail?.reviewDate || detail?.createdAt || new Date().toISOString(),
  };
}

function extractGeneric(detail, envMap) {
  const comment = detail?.comment || detail?.text || detail?.reviewText || deepScanForText(detail);
  return {
    provider: normalizeProvider(detail?.provider || detail?.contentProvider || ""),
    authorName: detail?.reviewerUserName || detail?.customerName || detail?.author || "Anonymous",
    comment: isNonEmptyString(comment) ? comment.trim() : "(no text)",
    rating: Number(detail?.rating || 0),
    locationId: String(detail?.locationId || ""),
    locationName: envMap[String(detail?.locationId)] || detail?.locationName || "Unknown",
    publicUrl: detail?.reviewURL || detail?.publicUrl || detail?.portalUrl || "",
    createdAt: detail?.reviewDate || detail?.createdAt || new Date().toISOString(),
  };
}

/**
 * Normalize a review into our internal shape using provider-specific rules.
 * @param {string} provider
 * @param {object} listItem   (optional) original list item
 * @param {object} detail     provider detail payload (preferred)
 * @param {object} envMap     locationId->name map from env
 */
export function extractReviewData(provider, listItem, detail, envMap = {}) {
  const p = normalizeProvider(provider || detail?.provider || detail?.contentProvider || "");
  if (p === "REVIEWBUILDER") return extractReviewBuilder(detail || listItem || {}, envMap);
  if (p === "YELP")          return extractYelp(detail || listItem || {}, envMap);
  if (p === "GOOGLE")        return extractGoogle(detail || listItem || {}, envMap);
  return extractGeneric(detail || listItem || {}, envMap);
}

/* ---------------- internal note ---------------- */
export function buildInternalNote({ dt, customer, provider, locationName, locationId, rating, comment, viewUrl }) {
  return [
    "**Review Information**",
    "",
    `Date: ${dt || "-"}`,
    `Customer: ${customer || "-"}`,
    `Provider: ${provider || "-"}`,
    `Location: ${locationName ? `${locationName} (${locationId || "-"})` : (locationId || "-")}`,
    `Rating: ${stars(rating)}`,
    "Comment:",
    (isNonEmptyString(comment) ? comment : "(no text)"),
    "",
    isNonEmptyString(viewUrl) ? `[View in Chatmeter](${viewUrl})` : "View in Chatmeter",
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ].join("\n");
}

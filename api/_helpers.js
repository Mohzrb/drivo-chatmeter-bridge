// /api/_helpers.js

/** -------------------- type helpers -------------------- **/
export function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}
export function isBooleanString(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim().toLowerCase();
  return t === "true" || t === "false";
}
export function looksLikeRating(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;    // 4 or 4.5
  if (/^★{1,5}$/.test(t)) return true;               // ★★★★☆
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;       // 4/5
  if (/^nps[:\s]/i.test(t)) return true;             // NPS: 9
  return false;
}

/** -------------------- provider normalization -------------------- **/
export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  if (!v) return "";
  const MAP = {
    "GOOGLE": "GOOGLE",
    "GOOGLE MAPS": "GOOGLE",
    "GMAPS": "GOOGLE",
    "YELP": "YELP",
    "TRUSTPILOT": "TRUSTPILOT",
    "TRUST PILOT": "TRUSTPILOT",
    "FACEBOOK": "FACEBOOK",
    "META": "FACEBOOK",
    "BING": "BING",
    "MICROSOFT": "BING",
    "REVIEWBUILDER": "REVIEWBUILDER",
    "SURVEYS": "SURVEYS",
  };
  return MAP[v] || v;
}

/** -------------------- RB extractor (robust) -------------------- **
 * Extracts open-text answers while ignoring booleans, links, dates and ratings.
 * Picks up to 3 distinct answers, longest/most-relevant first.
 */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const out = [];
  for (const r of rows) {
    const raw =
      r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(raw)) continue;

    const val = String(raw).trim();
    const name = String(r?.name || "").toLowerCase();

    // discard booleans, pure numbers/ratings, urls/dates
    if (isBooleanString(val)) continue;
    if (looksLikeRating(val)) continue;
    if (/^https?:\/\//i.test(val)) continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(val)) continue;

    // prefer typical free-text prompts
    const isOpen =
      /open|words|comment|describe|feedback|verbatim|free/i.test(name);

    out.push({ text: val, boost: isOpen ? 2 : 0, len: val.length });
  }

  if (!out.length) return "";

  out.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));

  const seen = new Set();
  const chosen = [];
  for (const c of out) {
    const k = c.text.toLowerCase();
    if (seen.has(k)) continue;
    chosen.push(c.text);
    seen.add(k);
    if (chosen.length >= 3) break;
  }
  return chosen.join("\n\n");
}

/** -------------------- provider-agnostic comment getter --------- **
 * If provider is REVIEWBUILDER (surveys), derive the open-text using
 * extractRBText. Otherwise prefer direct text fields.
 */
export function getProviderComment(provider, reviewLike) {
  const p = normalizeProvider(provider || reviewLike?.contentProvider || "");
  const direct =
    reviewLike?.comment ??
    reviewLike?.reviewText ??
    reviewLike?.text ??
    reviewLike?.body ??
    null;

  if (p === "REVIEWBUILDER") {
    const rb = extractRBText(reviewLike);
    if (isNonEmptyString(rb)) return rb;
    if (isNonEmptyString(direct) && !isBooleanString(direct)) return direct.trim();
    return "";
  }

  if (isNonEmptyString(direct) && !isBooleanString(direct)) return direct.trim();

  // try a few other common fields used by some providers
  const candidates = [
    reviewLike?.reviewerComment,
    reviewLike?.content,
    reviewLike?.review,
  ]
    .map((x) => (isNonEmptyString(x) ? x.trim() : ""))
    .filter(Boolean);

  if (candidates.length) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }
  return "";
}

/** -------------------- small helpers for formatting ------------- **/
export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

export function buildInternalNote({
  dt,
  customer,
  provider,
  locationName,
  locationId,
  rating,
  comment,
  viewUrl,
}) {
  return [
    "Review Information",
    "",
    `Date: ${dt || "-"}`,
    `Customer: ${customer || "-"}`,
    `Provider: ${provider || "-"}`,
    `Location: ${locationName ? `${locationName} (${locationId || "-"})` : (locationId || "-")}`,
    `Rating: ${stars(rating)}`,
    "Comment:",
    isNonEmptyString(comment) ? comment : "(no text)",
    "",
    isNonEmptyString(viewUrl) ? `View in Chatmeter` : "",
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ]
    .filter(Boolean)
    .join("\n");
}

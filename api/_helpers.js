// /api/_helpers.js

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
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;   // "5" or "4.0"
  if (/^★{1,5}$/.test(t)) return true;              // "★★★★★"
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;      // "4/5"
  if (/^nps[:\s]/i.test(t)) return true;            // "NPS: 9"
  return false;
}

/** Pull the best open-ended answer from ReviewBuilder reviewData */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const out = [];

  for (const r of rows) {
    const v = r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(v)) continue;
    if (isBooleanString(v)) continue;
    if (looksLikeRating(v)) continue;

    out.push({
      text: v.trim(),
      boost: isNonEmptyString(r?.name) && /open|comment|verbatim|free|own\s*words/i.test(r.name) ? 1 : 0,
      len: v.trim().length,
    });
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

/** Provider-agnostic comment getter */
export function getProviderComment(provider, review) {
  const p = (provider || review?.contentProvider || "").toUpperCase();
  const direct = review?.comment ?? review?.reviewText ?? review?.text ?? review?.body ?? null;

  if (p && p !== "REVIEWBUILDER" && isNonEmptyString(direct)) return direct.trim();
  if (p === "REVIEWBUILDER") {
    const rb = extractRBText(review);
    if (isNonEmptyString(rb)) return rb;
    if (isNonEmptyString(direct)) return direct.trim();
    return "";
  }
  return isNonEmptyString(direct) ? direct.trim() : "";
}

export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

export function buildInternalNote({ dt, customer, provider, locationName, locationId, rating, comment, viewUrl }) {
  return [
    "**Review Information**",
    "",
    `**Date:** ${dt || "-"}`,
    `**Customer:** ${customer || "-"}`,
    `**Provider:** ${provider || "-"}`,
    `**Location:** ${locationName ? `${locationName} (${locationId || "-"})` : (locationId || "-")}`,
    `**Rating:** ${stars(rating)}`,
    `**Comment:**`,
    isNonEmptyString(comment) ? comment : "(no text)",
    "",
    isNonEmptyString(viewUrl) ? `[View in Chatmeter](${viewUrl})` : "",
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ].filter(Boolean).join("\n");
}

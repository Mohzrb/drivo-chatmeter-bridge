// /api/_helpers.js

/** ---------- tiny utils ---------- */
export function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}
export function isBooleanString(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim().toLowerCase();
  return t === "true" || t === "false";
}
function looksLikeRating(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;      // "5" or "4.5"
  if (/^★{1,5}$/.test(t)) return true;                 // "★★★★★"
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;         // "4/5"
  if (/^nps[:\s]/i.test(t)) return true;               // "NPS: 9"
  return false;
}
function isNoise(x) {
  if (!isNonEmptyString(x)) return true;
  const s = x.trim();
  if (isBooleanString(s)) return true;                 // true/false
  if (looksLikeRating(s)) return true;                 // ratings
  if (/^https?:\/\//i.test(s)) return true;            // plain URL
  if (/^[A-Za-z0-9+/_=-]{40,}$/.test(s)) return true;  // long token-ish strings
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return true;      // ISO date
  return false;
}
export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

/** ---------- provider normalization ---------- */
export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  const MAP = {
    "GOOGLE MAPS": "GOOGLE",
    "GMAPS": "GOOGLE",
    "META": "FACEBOOK",
    "FB": "FACEBOOK",
    "TRUST PILOT": "TRUSTPILOT",
  };
  return MAP[v] || v;
}

/** ---------- ReviewBuilder free-text extraction ---------- */
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
      boost: isNonEmptyString(r?.name) && /open|comment|verbatim|free|own\s*words|describe/i.test(r.name) ? 1 : 0,
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

/** ---------- Generic text extraction (detail/list payloads) ---------- */
export function extractAnyText(obj) {
  if (!obj || typeof obj !== "object") return "";

  // 1) ReviewBuilder special case
  const provider = normalizeProvider(obj.contentProvider || obj.provider || "");
  if (provider === "REVIEWBUILDER") {
    const rb = extractRBText(obj);
    if (isNonEmptyString(rb)) return rb;
  }

  // 2) Common fields (Chatmeter detail often has one of these)
  const candidates = [
    obj.comment,
    obj.reviewText,
    obj.text,
    obj.body,
    obj.content,
    obj.reviewerComment,
    obj.snippet,
    obj.description
  ]
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .filter(v => isNonEmptyString(v) && !isNoise(v));

  if (candidates.length) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  // 3) Scan nested structures to find best long, non-noise string
  let best = "";
  (function scan(o) {
    if (typeof o === "string") {
      const s = o.trim();
      if (!isNoise(s) && s.length > best.length) best = s;
      return;
    }
    if (Array.isArray(o)) o.forEach(scan);
    else if (o && typeof o === "object") Object.values(o).forEach(scan);
  })(obj);

  return best;
}

/** ---------- Provider-agnostic comment getter from *list* item ---------- */
export function getProviderComment(provider, review) {
  const p = normalizeProvider(provider || review?.contentProvider || review?.provider || "");
  // direct text if good
  const direct = review?.comment ?? review?.reviewText ?? review?.text ?? review?.body ?? null;
  if (isNonEmptyString(direct) && !isNoise(direct)) return direct.trim();

  if (p === "REVIEWBUILDER") {
    const rb = extractRBText(review);
    if (isNonEmptyString(rb)) return rb;
  }
  return "";
}

/** ---------- Internal note builder ---------- */
export function buildInternalNote({ dt, customer, provider, locationName, locationId, rating, comment, viewUrl }) {
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
    isNonEmptyString(viewUrl) ? "View in Chatmeter" : "",
    isNonEmptyString(viewUrl) ? `[View in Chatmeter](${viewUrl})` : "",
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ].filter(Boolean).join("\n");
}

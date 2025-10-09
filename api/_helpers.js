// /api/_helpers.js
// Utility helpers for Chatmeter ⇄ Zendesk bridge

/** ---------- basic guards ---------- */
export const isNonEmptyString = (x) =>
  typeof x === "string" && x.trim().length > 0;

export const isBooleanString = (x) => {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim().toLowerCase();
  return t === "true" || t === "false";
};

/** numbers/stars/fractions/NPS that are not real comments */
function looksLikeRating(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;           // 5 or 4.0
  if (/^★{1,5}$/.test(t)) return true;                      // ★★★★★
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;              // 4/5
  if (/^nps[:\s]/i.test(t)) return true;                    // NPS: 9
  return false;
}

/** junk tokens we never want as a comment (urls, ids, uuids, encoded hashes, etc.) */
function isJunkText(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();

  // obvious junk
  if (isBooleanString(t)) return true;                      // true / false
  if (/^https?:\/\//i.test(t)) return true;                 // URL
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;           // ISO date/time
  if (looksLikeRating(t)) return true;                      // 5, 4/5, ★★★★☆

  // ids / uuids
  if (/^[A-Fa-f0-9]{24,}$/.test(t)) return true;            // 24+ hex (mongo-like)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return true; // UUID

  // Yelp/Google often return base64-ish or hex-like tokens when no text is available.
  // Treat as junk only if it's a long no-space string with *no vowels* (to avoid killing real short words).
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(t) && !/\s/.test(t) && !/[aeiou]/i.test(t)) return true;

  return false;
}

/** ---------- ReviewBuilder / Surveys free-text extraction ---------- */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const candidates = [];

  for (const r of rows) {
    const v =
      r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(v)) continue;

    const val = String(v).trim();
    if (isBooleanString(val)) continue;
    if (looksLikeRating(val)) continue;

    const name = String(r?.name || "").toLowerCase();
    const boost = /open|own\s*words|comment|verbatim|describe|feedback|text/.test(
      name
    )
      ? 1
      : 0;

    candidates.push({ text: val, boost, len: val.length });
  }

  if (!candidates.length) return "";

  candidates.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));

  // de-dupe & cap
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const k = c.text.toLowerCase();
    if (seen.has(k)) continue;
    out.push(c.text);
    seen.add(k);
    if (out.length >= 3) break;
  }
  return out.join("\n\n");
}

/** ---------- Provider-agnostic comment getter ---------- */
export function getProviderComment(providerInput, review) {
  const provider = (
    providerInput ||
    review?.contentProvider ||
    review?.provider ||
    ""
  )
    .toString()
    .toUpperCase();

  // 1) Provider-specific (ReviewBuilder / Surveys)
  if (provider === "REVIEWBUILDER" || provider === "SURVEYS") {
    const rb = extractRBText(review);
    if (isNonEmptyString(rb) && !isJunkText(rb)) return rb;
    // fall through to generic direct fields if RB had nothing
  }

  // 2) Common direct locations used by Google / Yelp / FB / TP and RB fallbacks
  const directFields = [
    review?.text,
    review?.comment,
    review?.body,
    review?.reviewText,
    review?.review,
    review?.reviewerComment,
  ]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .filter((s) => !isJunkText(s));

  if (directFields.length) {
    // prefer the longest meaningful string
    directFields.sort((a, b) => b.length - a.length);
    return directFields[0];
  }

  // 3) Some providers accidentally stuff things into reviewData values
  if (Array.isArray(review?.reviewData)) {
    const rdVals = review.reviewData
      .map((r) => (isNonEmptyString(r?.value) ? String(r.value).trim() : ""))
      .filter((s) => s && !isJunkText(s));
    if (rdVals.length) {
      rdVals.sort((a, b) => b.length - a.length);
      return rdVals[0];
    }
  }

  // 4) Deep scan as last resort (skip urls/dates/booleans/ratings/junk)
  let best = "";
  (function scan(o) {
    if (!o) return;
    if (typeof o === "string") {
      const s = o.trim();
      if (!s || isJunkText(s)) return;
      if (s.length > best.length) best = s;
      return;
    }
    if (Array.isArray(o)) o.forEach(scan);
    else if (typeof o === "object") Object.values(o).forEach(scan);
  })(review);

  return best || "";
}

/** ---------- Formatting helpers ---------- */
export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  const MAP = {
    "GOOGLE MAPS": "GOOGLE",
    GMAPS: "GOOGLE",
    "TRUST PILOT": "TRUSTPILOT",
    META: "FACEBOOK",
    FB: "FACEBOOK",
    MICROSOFT: "BING",
  };
  return MAP[v] || v;
}

/** pick best customer contact fields if present */
export function pickCustomerContact(o = {}) {
  const email =
    o.reviewerEmail || o.authorEmail || o.email || o.customerEmail || "";
  const phone =
    o.reviewerPhone || o.authorPhone || o.phone || o.customerPhone || "";
  return {
    email: isNonEmptyString(email) ? String(email).trim() : "",
    phone: isNonEmptyString(phone) ? String(phone).trim() : "",
  };
}

/** Build INTERNAL note exactly like your structure (with markdown link) */
export function buildInternalNote({
  dt,
  customerName,
  customerEmail,
  customerPhone,
  provider,
  locationName,
  locationId,
  rating,
  comment,
  viewUrl,
}) {
  const lines = [
    "Review Information",
    "",
    `Date: ${dt || "-"}`,
    `Customer: ${customerName || "-"}`,
    `Provider: ${provider || "-"}`,
    `Location: ${
      locationName ? `${locationName} (${locationId || "-"})` : locationId || "-"
    }`,
    `Rating: ${stars(rating)}`,
    "Comment:",
    isNonEmptyString(comment) ? comment : "(no text)",
    "",
  ];

  if (isNonEmptyString(viewUrl)) {
    lines.push(`[View in Chatmeter](${viewUrl})`);
  }

  lines.push(
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._"
  );

  // optionally include contact (on separate lines below “Customer”)
  const contactLines = [];
  if (isNonEmptyString(customerEmail)) contactLines.push(customerEmail.trim());
  if (isNonEmptyString(customerPhone)) contactLines.push(customerPhone.trim());
  if (contactLines.length) {
    // insert right after Customer line
    lines.splice(4, 0, ...contactLines);
  }

  return lines.filter(Boolean).join("\n");
}

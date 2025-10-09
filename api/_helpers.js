// /api/_helpers.js
// Unified helper for Chatmeter → Zendesk bridge (final)

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function isBooleanString(v) {
  if (!isNonEmptyString(v)) return false;
  const t = v.trim().toLowerCase();
  return t === "true" || t === "false";
}

function looksLikeRating(x) {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  return (
    /^[0-9]+(\.[0-9]+)?$/.test(t) || // 5, 4.0
    /^★{1,5}$/.test(t) ||            // ★★★★☆
    /^[0-9]+\/[0-9]+$/.test(t) ||    // 4/5
    /^nps[:\s]/i.test(t)             // NPS: 9
  );
}

/** Treat obvious junk as non-comment (hashes, urls, ids…) */
function isJunkText(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();

  if (isBooleanString(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;
  if (looksLikeRating(t)) return true;

  // 24-hex (mongo-like)
  if (/^[A-Fa-f0-9]{24}$/.test(t)) return true;
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return true;
  // Base64-ish long token with no vowels (e.g., Yelp/Google ids)
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(t) && !/\s/.test(t) && !/[aeiou]/i.test(t)) return true;

  return false;
}

/** ---------- Provider & contact ---------- */
export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  const MAP = { "GOOGLE MAPS": "GOOGLE", GMAPS: "GOOGLE", META: "FACEBOOK", FB: "FACEBOOK", "TRUST PILOT": "TRUSTPILOT" };
  return MAP[v] || v;
}

export function pickCustomerContact(o = {}) {
  const email = o.reviewerEmail || o.authorEmail || o.email || o.customerEmail || "";
  const phone = o.reviewerPhone || o.authorPhone || o.phone || o.customerPhone || "";
  return {
    email: isNonEmptyString(email) ? email.trim() : "",
    phone: isNonEmptyString(phone) ? phone.trim() : "",
  };
}

/** ---------- Comment extraction helpers ---------- */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const out = [];

  for (const r of rows) {
    const v = r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(v)) continue;
    const val = String(v).trim();
    if (isBooleanString(val) || looksLikeRating(val) || isJunkText(val)) continue;

    const name = String(r?.name || "").toLowerCase();
    const boost = /open|own\s*words|comment|verbatim|describe|feedback|text/.test(name) ? 1 : 0;
    out.push({ text: val, boost, len: val.length });
  }

  if (!out.length) return "";
  out.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));

  const seen = new Set(); const chosen = [];
  for (const c of out) {
    const k = c.text.toLowerCase();
    if (seen.has(k)) continue;
    chosen.push(c.text);
    seen.add(k);
    if (chosen.length >= 3) break;
  }
  return chosen.join("\n\n");
}

function extractYelpGoogleComment(review) {
  return (
    (isNonEmptyString(review.text) ? review.text.trim() : "") ||
    (isNonEmptyString(review.reviewBody) ? review.reviewBody.trim() : "") ||
    (isNonEmptyString(review.body) ? review.body.trim() : "") ||
    (isNonEmptyString(review.snippet) ? review.snippet.trim() : "") ||
    (isNonEmptyString(review.comment) ? review.comment.trim() : "")
  );
}

/** ---------- FINAL: provider-agnostic comment getter (improved) ---------- */
export function getProviderComment(reviewProviderOrObj, maybeReview) {
  // Allow both signatures: (provider, review) or (review)
  const review = maybeReview ?? reviewProviderOrObj;
  const providerInput = maybeReview ? reviewProviderOrObj : (review?.contentProvider || review?.provider);
  const provider = normalizeProvider(providerInput);

  let text = "";

  if (provider === "REVIEWBUILDER" || provider === "SURVEYS") {
    // If comment is present and not boolean/junk, use it; otherwise RB free-text
    if (isNonEmptyString(review?.comment) && !isJunkText(review.comment)) {
      text = review.comment.trim();
    } else {
      text = extractRBText(review);
    }
  } else if (provider === "GOOGLE" || provider === "YELP") {
    text = extractYelpGoogleComment(review);
  } else {
    // Other providers
    const direct = [
      review?.text,
      review?.comment,
      review?.body,
      review?.reviewText,
      review?.review,
      review?.reviewerComment,
    ]
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((s) => s && !isJunkText(s));
    if (direct.length) {
      direct.sort((a, b) => b.length - a.length);
      text = direct[0];
    }
  }

  if (!isNonEmptyString(text) || isJunkText(text)) return "";
  return text;
}

/** ---------- Formatting ---------- */
export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

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
    `Location: ${locationName ? `${locationName} (${locationId || "-"})` : locationId || "-"}`,
    `Rating: ${stars(rating)}`,
    "Comment:",
    isNonEmptyString(comment) ? comment : "(no text)",
    "",
  ];

  if (isNonEmptyString(viewUrl)) lines.push(`[View in Chatmeter](${viewUrl})`);

  lines.push("", "_The first public comment on this ticket will be posted to Chatmeter._");

  // optional contact lines just after Customer
  const contact = [];
  if (isNonEmptyString(customerEmail)) contact.push(customerEmail.trim());
  if (isNonEmptyString(customerPhone)) contact.push(customerPhone.trim());
  if (contact.length) lines.splice(4, 0, ...contact);

  return lines.filter(Boolean).join("\n");
}

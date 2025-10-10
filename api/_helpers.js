// /api/_helpers.js — final helper set for Chatmeter ⇄ Zendesk bridge

/* -------------------- small predicates -------------------- */
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
    /^[0-9]+(\.[0-9]+)?$/.test(t) ||   // 5, 4.0
    /^★{1,5}$/.test(t) ||              // ★★★★☆
    /^[0-9]+\/[0-9]+$/.test(t) ||      // 4/5
    /^nps[:\s]/i.test(t)               // NPS: 9
  );
}
function isJunkText(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();
  if (isBooleanString(t)) return true;                 // true/false
  if (/^https?:\/\//i.test(t)) return true;            // URL
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;      // ISO date
  if (looksLikeRating(t)) return true;                 // ratings
  if (/^[A-Fa-f0-9]{24}$/.test(t)) return true;        // 24-hex id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return true; // uuid
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(t) && !/\s/.test(t) && !/[aeiou]/i.test(t)) return true;            // token-ish
  return false;
}

/* -------------------- provider & contact -------------------- */
export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  const MAP = {
    "GOOGLE MAPS": "GOOGLE",
    GMAPS: "GOOGLE",
    META: "FACEBOOK",
    FB: "FACEBOOK",
    "TRUST PILOT": "TRUSTPILOT",
  };
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

/* -------------------- comment extraction -------------------- */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  if (!rows.length) return "";

  const candidates = [];
  for (const r of rows) {
    const name = String(r?.name || "").toLowerCase();
    const raw  = r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? "";
    if (!isNonEmptyString(String(raw))) continue;
    const val = String(raw).trim();
    if (isBooleanString(val) || looksLikeRating(val) || isJunkText(val)) continue;

    const boost =
      /open|own\s*words|comment|verbatim|describe|feedback|text|in\s+your\s+own\s+words/.test(name) ? 2 : 0;
    // small length boost so longer, more informative answers win
    const lenBoost = Math.min(2, Math.floor(val.length / 120));
    candidates.push({ text: val, score: boost + lenBoost });
  }

  if (!candidates.length) return "";
  candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    const k = c.text.toLowerCase();
    if (seen.has(k)) continue;
    out.push(c.text);
    seen.add(k);
    if (out.length >= 3) break;
  }
  return out.join("\n\n");
}

function extractYelpGoogleComment(review) {
  const fields = [
    review?.text,
    review?.reviewText,
    review?.review_body,
    review?.reviewBody,
    review?.body,
    review?.snippet,
    review?.content,
    review?.reviewerComment,
    review?.comment,
  ];
  for (const f of fields) {
    if (isNonEmptyString(f) && !isJunkText(f)) return String(f).trim();
  }
  return "";
}

/**
 * Provider-agnostic comment getter.
 * Accepts (provider, review) OR (review) — both signatures supported.
 */
export function getProviderComment(reviewProviderOrObj, maybeReview) {
  const review = maybeReview ?? reviewProviderOrObj;
  const providerInput = maybeReview ? reviewProviderOrObj : (review?.contentProvider || review?.provider);
  const provider = normalizeProvider(providerInput);

  let text = "";

  if (provider === "REVIEWBUILDER" || provider === "SURVEYS") {
    // If direct comment is a real string, use it; otherwise pull from reviewData
    if (isNonEmptyString(review?.comment) && !isJunkText(review.comment)) {
      text = review.comment.trim();
    } else {
      text = extractRBText(review);
    }
  } else if (provider === "GOOGLE" || provider === "YELP") {
    text = extractYelpGoogleComment(review);
  } else {
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

/* -------------------- formatting -------------------- */
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

  // optional contact lines, directly under Customer
  const contact = [];
  if (isNonEmptyString(customerEmail)) contact.push(customerEmail.trim());
  if (isNonEmptyString(customerPhone)) contact.push(customerPhone.trim());
  if (contact.length) lines.splice(4, 0, ...contact);

  return lines.filter(Boolean).join("\n");
}

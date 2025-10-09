// /api/_helpers.js
// Unified helper for Chatmeter → Zendesk bridge (2025-10-10)

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
  return (
    /^[0-9]+(\.[0-9]+)?$/.test(t) || // 5, 4.0
    /^★{1,5}$/.test(t) ||            // ★★★★
    /^[0-9]+\/[0-9]+$/.test(t) ||    // 4/5
    /^nps[:\s]/i.test(t)             // NPS: 9
  );
}

/**
 * Detect "junk" strings (hashes, booleans, timestamps, etc.)
 * Yelp sometimes gives 24-char hashes — filter them cleanly.
 */
function isJunkText(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();

  if (isBooleanString(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;
  if (looksLikeRating(t)) return true;

  // Mongo-style hex ID
  if (/^[A-Fa-f0-9]{24}$/.test(t)) return true;

  // Base64-like hash (Yelp/Google)
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(t) && !/\s/.test(t) && !/[aeiou]/i.test(t))
    return true;

  return false;
}

/** Extract meaningful free-text from ReviewBuilder survey answers */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const out = [];

  for (const r of rows) {
    const v =
      r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(v)) continue;

    const val = v.trim();
    if (isBooleanString(val) || looksLikeRating(val) || isJunkText(val)) continue;

    const name = String(r?.name || "").toLowerCase();
    const boost = /open|own\s*words|comment|verbatim|describe|feedback|text/.test(
      name
    )
      ? 1
      : 0;

    out.push({ text: val, boost, len: val.length });
  }

  if (!out.length) return "";
  out.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));

  const seen = new Set();
  const chosen = [];
  for (const c of out) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    chosen.push(c.text);
    seen.add(key);
    if (chosen.length >= 3) break;
  }
  return chosen.join("\n\n");
}

/** Normalize provider names (Google Maps → GOOGLE, etc.) */
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

/** Best-effort comment extractor for all providers */
export function getProviderComment(providerInput, review) {
  const provider = normalizeProvider(
    providerInput || review?.contentProvider || review?.provider || ""
  );

  // ReviewBuilder first
  if (provider === "REVIEWBUILDER" || provider === "SURVEYS") {
    const rb = extractRBText(review);
    if (isNonEmptyString(rb)) return rb;
  }

  // Direct fields
  const direct = [
    review?.comment,
    review?.reviewText,
    review?.text,
    review?.body,
    review?.review,
  ]
    .map((x) => (isNonEmptyString(x) ? x.trim() : ""))
    .filter((s) => s && !isJunkText(s));

  if (direct.length) {
    direct.sort((a, b) => b.length - a.length);
    return direct[0];
  }

  // Fallback: scan reviewData if present
  if (Array.isArray(review?.reviewData)) {
    const rd = review.reviewData
      .map((r) => (isNonEmptyString(r?.value) ? r.value.trim() : ""))
      .filter((v) => v && !isJunkText(v));
    if (rd.length) {
      rd.sort((a, b) => b.length - a.length);
      return rd[0];
    }
  }

  // Final deep scan
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

/** Customer contact fields */
export function pickCustomerContact(o = {}) {
  const email =
    o.reviewerEmail || o.authorEmail || o.email || o.customerEmail || "";
  const phone =
    o.reviewerPhone || o.authorPhone || o.phone || o.customerPhone || "";
  return {
    email: isNonEmptyString(email) ? email.trim() : "",
    phone: isNonEmptyString(phone) ? phone.trim() : "",
  };
}

export function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}

/** Build internal note formatted for Zendesk */
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

  if (isNonEmptyString(viewUrl))
    lines.push(`[View in Chatmeter](${viewUrl})`);

  lines.push(
    "",
    "_The first public comment on this ticket will be posted to Chatmeter._"
  );

  if (isNonEmptyString(customerEmail) || isNonEmptyString(customerPhone)) {
    lines.splice(
      4,
      0,
      ...(isNonEmptyString(customerEmail) ? [customerEmail.trim()] : []),
      ...(isNonEmptyString(customerPhone) ? [customerPhone.trim()] : [])
    );
  }

  return lines.filter(Boolean).join("\n");
}

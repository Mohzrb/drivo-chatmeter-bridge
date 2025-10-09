// /api/_helpers.js

export const isNonEmptyString = (x) =>
  typeof x === "string" && x.trim().length > 0;

export const isBooleanString = (x) => {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim().toLowerCase();
  return t === "true" || t === "false";
};

const looksLikeRating = (x) => {
  if (!isNonEmptyString(x)) return false;
  const t = x.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;   // 5 or 4.0
  if (/^★{1,5}$/.test(t)) return true;              // ★★★★★
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;      // 4/5
  if (/^nps[:\s]/i.test(t)) return true;            // NPS: 9
  return false;
};

/** Extract best free-text from ReviewBuilder reviewData */
export function extractRBText(review) {
  const rows = Array.isArray(review?.reviewData) ? review.reviewData : [];
  const keep = [];

  for (const r of rows) {
    const v = r?.value ?? r?.answer ?? r?.text ?? r?.comment ?? r?.response ?? null;
    if (!isNonEmptyString(v)) continue;
    if (isBooleanString(v)) continue;
    if (looksLikeRating(v)) continue;

    const name = String(r?.name || "").toLowerCase();
    const boost = /open|own\s*words|comment|verbatim|describe|feedback|text/.test(name) ? 1 : 0;
    keep.push({ text: v.trim(), boost, len: v.trim().length });
  }
  if (!keep.length) return "";
  keep.sort((a, b) => (b.boost - a.boost) || (b.len - a.len));

  // de-dupe & limit
  const seen = new Set();
  const out = [];
  for (const k of keep) {
    const low = k.text.toLowerCase();
    if (seen.has(low)) continue;
    out.push(k.text);
    seen.add(low);
    if (out.length >= 3) break;
  }
  return out.join("\n\n");
}

/** Provider-agnostic text getter (works for Google/Yelp/TP/FB/ReviewBuilder/Surveys) */
export function getProviderComment(providerInput, review) {
  const provider = (providerInput || review?.contentProvider || review?.provider || "").toString().toUpperCase();

  // direct text first
  const direct =
    review?.comment ??
    review?.reviewText ??
    review?.text ??
    review?.body ??
    review?.content ??
    review?.reviewerComment ??
    null;

  if (provider === "REVIEWBUILDER" || provider === "SURVEYS") {
    const rb = extractRBText(review);
    if (isNonEmptyString(rb)) return rb;
    if (isNonEmptyString(direct) && !isBooleanString(direct) && !looksLikeRating(direct)) return direct.trim();
    return "";
  }

  if (isNonEmptyString(direct) && !isBooleanString(direct) && !looksLikeRating(direct)) {
    return direct.trim();
  }

  // deep scan fallback
  let best = "";
  const scan = (o) => {
    if (!o) return;
    if (typeof o === "string") {
      const s = o.trim();
      if (!s) return;
      if (/^https?:\/\//i.test(s)) return;          // skip links
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return;     // skip ISO date
      if (isBooleanString(s)) return;                // skip true/false
      if (looksLikeRating(s)) return;                // skip "5", "NPS: 9"
      if (s.length > best.length) best = s;
      return;
    }
    if (Array.isArray(o)) o.forEach(scan);
    else if (typeof o === "object") Object.values(o).forEach(scan);
  };
  scan(review);
  return best;
}

export const stars = (n) => {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x);
};

export function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  const MAP = {
    "GOOGLE MAPS": "GOOGLE", "GMAPS": "GOOGLE",
    "TRUST PILOT": "TRUSTPILOT",
    "META": "FACEBOOK", "FB": "FACEBOOK",
    "MICROSOFT": "BING"
  };
  return MAP[v] || v;
}

/** Build the INTERNAL card exactly like your screenshot (plus optional link) */
export function buildInternalNote({
  dt, customerName, customerEmail, customerPhone,
  provider, locationName, locationId, rating, comment, viewUrl
}) {
  const lines = [
    "Review Information:",
    "",
    `Date: ${dt || "-"}`,
  ];
  if (customerName || customerEmail || customerPhone) {
    lines.push(
      `Customer: ${customerName || "-"}`,
      customerEmail ? String(customerEmail).trim() : null,
      customerPhone ? String(customerPhone).trim() : null
    );
  }
  lines.push(
    "",
    `Location: ${locationName ? `${locationName}` : "Unknown"}${locationId ? "" : ""}`
  );
  lines.push(
    "",
    "Comment:",
    isNonEmptyString(comment) ? comment : "(no text)",
    ""
  );
  if (isNonEmptyString(viewUrl)) lines.push("View in Chatmeter");
  lines.push(
    "",
    "The first comment on this ticket will be recorded as your response to Chatmeter. Any messages after will not be sent and you can work the ticket as normal."
  );

  return lines.filter((x) => x !== null).join("\n");
}

/** pick best email / phone if present */
export function pickCustomerContact(o = {}) {
  const email =
    o.reviewerEmail || o.authorEmail || o.email || o.customerEmail || "";
  const phone =
    o.reviewerPhone || o.authorPhone || o.phone || o.customerPhone || "";

  return {
    email: isNonEmptyString(email) ? String(email).trim() : "",
    phone: isNonEmptyString(phone) ? String(phone).trim() : ""
  };
}

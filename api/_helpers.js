// /api/_helpers.js
// Shared helpers for Chatmeter → Zendesk bridge

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function isBooleanString(v) {
  return typeof v === "string" && /^(true|false)$/i.test(v.trim());
}

export function normalizeProvider(p) {
  if (!p) return "";
  const t = p.toString().toUpperCase();
  if (t.includes("GOOGLE")) return "GOOGLE";
  if (t.includes("YELP")) return "YELP";
  if (t.includes("REVIEWBUILDER")) return "REVIEWBUILDER";
  if (t.includes("FACEBOOK")) return "FACEBOOK";
  return t;
}

export function pickCustomerContact(inBody) {
  const email =
    inBody.email ||
    inBody.customerEmail ||
    inBody.authorEmail ||
    inBody.contactEmail ||
    "";
  const phone =
    inBody.phone ||
    inBody.customerPhone ||
    inBody.authorPhone ||
    inBody.contactPhone ||
    "";
  return { email, phone };
}

/* -------------------- FIXED COMMENT EXTRACTOR -------------------- */
export function getProviderComment(provider, data = {}) {
  if (!data || typeof data !== "object") return "";

  const paths = [
    "comment",
    "review.comment",
    "review.text",
    "text",
    "body",
    "reviewBody",
    "reviewData.commentText",
    "reviewData.freeText",
    "reviewData.reviewBody",
  ];

  for (const path of paths) {
    const parts = path.split(".");
    let val = data;
    for (const p of parts) val = val && typeof val === "object" ? val[p] : undefined;
    if (isNonEmptyString(val)) {
      const cleaned = String(val).trim();
      if (
        cleaned &&
        !/^(true|false|null|undefined)$/i.test(cleaned) &&
        !/^[A-Za-z0-9+/_=-]{20,}$/.test(cleaned)
      ) {
        return cleaned;
      }
    }
  }

  // Some ReviewBuilder reviews store text in "answers"
  if (Array.isArray(data.answers)) {
    const answer = data.answers.find(a => a && a.question && /experience|feedback/i.test(a.question));
    if (answer && isNonEmptyString(answer.answer)) {
      return answer.answer.trim();
    }
  }

  return "";
}

/* -------------------- INTERNAL NOTE BUILDER -------------------- */
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
  const ratingStars = "★".repeat(rating) + "☆".repeat(5 - rating);
  const safeComment = comment && comment.trim() ? comment.trim() : "(no text)";

  const lines = [
    `Review Information`,
    `Date: ${dt}`,
    `Customer: ${customerName || "N/A"}`,
    `Provider: ${provider}`,
    `Location: ${locationName} (${locationId})`,
    `Rating: ${ratingStars}`,
    `Comment:`,
    safeComment,
    "",
    viewUrl ? `[View in Chatmeter](${viewUrl})` : "",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ];

  return lines.join("\n");
}

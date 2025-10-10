// /api/_helpers.js
// FINAL version with deep ReviewBuilder comment extraction

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
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

/* ------------------------------------------------------------------ */
/* DEEP COMMENT DETECTION (for ReviewBuilder Q&A structure)            */
/* ------------------------------------------------------------------ */
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
      const cleaned = val.trim();
      if (!/^(true|false|null|undefined)$/i.test(cleaned)) {
        return cleaned;
      }
    }
  }

  // ✅ Handle ReviewBuilder structured `reviewData` array
  if (Array.isArray(data.reviewData)) {
    const answer = data.reviewData.find(
      (a) =>
        a &&
        a.name &&
        /own words|experience|feedback|describe/i.test(a.name) &&
        isNonEmptyString(a.value)
    );
    if (answer) return answer.value.trim();
  }

  // ✅ Handle legacy "answers" array
  if (Array.isArray(data.answers)) {
    const answer = data.answers.find(
      (a) =>
        a &&
        a.question &&
        /own words|experience|feedback|describe/i.test(a.question) &&
        isNonEmptyString(a.answer)
    );
    if (answer) return answer.answer.trim();
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

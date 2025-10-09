// _helpers.js
export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0 && v !== "false" && v !== "true";
}

export function normalizeProvider(provider) {
  if (!provider) return "";
  return String(provider).trim().toUpperCase();
}

export function buildInternalNote({ review, link }) {
  const date = review.reviewDate || review.dateAdded || review.date || "";
  const customer = review.reviewerUserName || review.customerName || review.name || "";
  const provider = normalizeProvider(review.contentProvider || review.provider);
  const location = `${review.locationName || ""} (${review.locationId || ""})`;
  const rating = "★".repeat(review.rating || 0);
  const comment =
    review.comment && isNonEmptyString(review.comment)
      ? review.comment
      : extractReviewBuilderComment(review) || "(no text)";

  return (
    `Review Information\n` +
    `Date: ${date}\n` +
    `Customer: ${customer}\n` +
    `Provider: ${provider}\n` +
    `Location: ${location}\n` +
    `Rating: ${rating}\n` +
    `Comment:\n${comment}\n\n` +
    `[View in Chatmeter](${link})`
  );
}

function extractReviewBuilderComment(review) {
  if (!review.reviewData || !Array.isArray(review.reviewData)) return "";
  const field = review.reviewData.find((r) =>
    /in your own words|describe.*experience/i.test(r.name)
  );
  return field?.value?.trim() || "";
}

export function pickCustomerContact(review) {
  return (
    review.reviewerEmail ||
    review.email ||
    (review.reviewer && review.reviewer.email) ||
    ""
  );
}

export function getProviderComment(review) {
  return (
    review.comment ||
    (review.reviewData && review.reviewData.map((r) => r.value).join(" ")) ||
    ""
  );
}

export function buildZendeskSubject({ review }) {
  const loc = review.locationName || review.locationId || "Unknown";
  const stars = "★".repeat(review.rating || 0);
  const name = review.reviewerUserName || review.customerName || "Unknown";
  return `${loc} – ${stars} – ${name}`;
}

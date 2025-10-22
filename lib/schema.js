/**
 * Normalize a Chatmeter review into a stable shape we can send to Zendesk.
 * Handles provider/source names (Google, Yelp, etc.) and common field variants.
 */
export function normalizeReview(raw) {
  const id =
    String(raw.id || raw.reviewId || raw.uuid || raw._id || "").trim();

  const rating = Number(
    raw.rating ?? raw.stars ?? raw.score ?? 0
  );

  const content = String(
    raw.content || raw.text || raw.body || ""
  ).trim();

  const authorName = String(
    raw.author?.name || raw.user?.name || raw.userName || "Anonymous"
  ).trim();

  const createdAt =
    raw.createdAt || raw.created || raw.date || new Date().toISOString();

  const locationName =
    raw.location?.name || raw.locationName || raw.location || "";

  // Normalize provider/platform → a simple, stable "source"
  const provider = (raw.platform || raw.provider || raw.source || raw.site || "")
    .toString()
    .toLowerCase();

  let source = "other";
  if (provider.includes("google")) source = "google";
  else if (provider.includes("yelp")) source = "yelp";
  else if (provider.includes("expedia")) source = "expedia";
  else if (provider.includes("trip") && provider.includes("advisor")) source = "tripadvisor";

  const url = raw.url || raw.link || raw.permalink || "";

  return {
    id,
    rating,
    content,
    authorName,
    createdAt,
    locationName,
    source,
    url
  };
}

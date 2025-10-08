// api/_card.js
// Normalize any Chatmeter payload shape and build the exact beige-card text.

const isNonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const first = (...vals) => vals.find(isNonEmpty);

// Lowercase + dot-join keys
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, ".");

// Deep-flatten object/array to key -> value
function flatten(obj, base = "", out = {}) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object") { out[base || ""] = obj; return out; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => flatten(v, base ? `${base}.${i}` : String(i), out)); return out; }
  for (const [k, v] of Object.entries(obj)) flatten(v, base ? `${base}.${normKey(k)}` : normKey(k), out);
  return out;
}

function pick(flat, keysOrRegexes) {
  for (const cand of keysOrRegexes) {
    if (cand instanceof RegExp) {
      for (const [k, v] of Object.entries(flat)) if (cand.test(k) && isNonEmpty(v)) return v;
    } else {
      const v = flat[normKey(cand)];
      if (isNonEmpty(v)) return v;
    }
  }
  return undefined;
}

function inferOrigin(provider, url) {
  if (isNonEmpty(provider)) return String(provider).toUpperCase();
  try {
    if (isNonEmpty(url)) {
      const h = new URL(String(url)).hostname;
      if (/google/i.test(h)) return "GOOGLE";
      if (/yelp/i.test(h)) return "YELP";
      if (/facebook|fb\.com/i.test(h)) return "FACEBOOK";
      if (/chatmeter/i.test(h)) return "REVIEWBUILDER";
    }
  } catch {}
  return "PROVIDER";
}

function extract(payload) {
  const flat = flatten(payload);

  const externalId = pick(flat, [/external\.?id/]);
  const reviewId = first(
    pick(flat, [/(\.|^)review(\.|_)?id(\.|$)/, "review_id", "review.id", "payload.review_id", "id"]),
    (typeof externalId === "string" && externalId.startsWith("chatmeter:")) ? externalId.slice(10) : undefined
  );

  const rating       = pick(flat, [/(\.|^)rating(\.|$)/, /(\.|^)stars?(\.|$)/, "review.rating", "payload.rating"]);
  const locationId   = pick(flat, [/location(\.|_)?id(\.|$)/, "review.location_id", "payload.location_id"]);
  const locationName = first(
    pick(flat, [/(\.|^)location(\.|$)/, /location(\.|_)name/, "review.location_name", "payload.location_name", "business.name", "site.name"]),
    locationId ? `Location` : undefined
  );
  const publicUrl    = pick(flat, [/public.*url/, /(\.|^)url(\.|$)/, /(\.|^)link(\.|$)/, "review.public_url", "review.url"]);
  const reviewDate   = pick(flat, [/review.*date/, /created(_|\.|)at/, /^date$/]);
  const author       = first(
    pick(flat, [/(\.|^)author(\.|$)/, /(\.|^)reviewer(\.|$)/, "review.author", "payload.author", "reviewer_name"]),
    "Reviewer"
  );
  const providerRaw  = pick(flat, [/(\.|^)provider(\.|$)/, /(\.|^)source(\.|$)/]);
  const provider     = inferOrigin(providerRaw, publicUrl);

  // Text from many places
  let text = pick(flat, [
    /review.*text/, /(\.|^)text(\.|$)/, /(\.|^)comment(\.|$)/, /(\.|^)content(\.|$)/,
    /(\.|^)body(\.|$)/, /(\.|^)message(\.|$)/, /(\.|^)snippet(\.|$)/, /(\.|^)description(\.|$)/
  ]);

  const subject = `${locationName || "Location"} – ${isNonEmpty(rating) ? rating : "?"}★ – ${author}`;
  return { subject, data: { reviewId, provider, locationName, locationId, rating, reviewDate, text, publicUrl } };
}

function buildPlainCard(d) {
  // EXACT spacing/lines requested
  const lines = [
    `Review ID: ${d.reviewId ?? ""}`.trimEnd(),
    `Provider: ${d.provider ?? ""}`.trimEnd(),
    `Location: ${d.locationName ?? "Location"} (${d.locationId ?? "N/A"})`,
    `Rating: ${isNonEmpty(d.rating) ? d.rating : "N/A"}★`,
    `Date: ${d.reviewDate ?? "N/A"}`,
    `Review Text:`,
    ``,
    isNonEmpty(d.text) ? String(d.text) : `(no text)`,
    ``,
    `Public URL:`,
    d.publicUrl ? String(d.publicUrl) : ``
  ];
  return lines.join("\n");
}

module.exports = { extract, buildPlainCard };

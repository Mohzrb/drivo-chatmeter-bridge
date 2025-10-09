// ... keep your imports/env reads

// --- Add these helpers near the top ---
function isGoodText(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  // Don’t mistake hex-like IDs for comments
  if (/^[a-f0-9]{24}$/i.test(s)) return false;
  return true;
}
// --- Provider normalization (Chatmeter can vary names per source)
function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  if (!v) return "";

  // Map common variants to a single label
  const MAP = {
    "GOOGLE": "GOOGLE",
    "GOOGLE MAPS": "GOOGLE",
    "GMAPS": "GOOGLE",
    "YELP": "YELP",
    "TRUSTPILOT": "TRUSTPILOT",
    "TRUST PILOT": "TRUSTPILOT",
    "FACEBOOK": "FACEBOOK",
    "META": "FACEBOOK",
    "FB": "FACEBOOK",
    "BING": "BING",
    "MICROSOFT": "BING",
    "REVIEWBUILDER": "REVIEWBUILDER",
    "SURVEYS": "SURVEYS"
  };

  return MAP[v] || v; // fall back to the raw upper value
}

// --- Extract a readable text/comment across ALL providers (incl. surveys)
function extractReviewText(item) {
  // 1) direct text if present
  if (item?.text && String(item.text).trim()) return String(item.text).trim();

  // 2) Chatmeter sometimes sends "reviewData" with survey/NPX answers
  //    Look for commonly used keys and take the first non-empty free text.
  const data = Array.isArray(item?.reviewData) ? item.reviewData : [];
  if (data.length) {
    // Look for typical free-form answers Chatmeter uses
    const KEYS = [
      "nptext", "freeformAnswer", "comment", "text", "reviewText"
    ];

    for (const d of data) {
      const name = (d?.name || "").toString().toLowerCase();
      if (KEYS.includes(name) && d?.value && String(d.value).trim()) {
        return String(d.value).trim();
      }
    }

    // fallback: join any freeform-like values
    const joined = data
      .map(d => d?.value)
      .filter(v => v && String(v).trim())
      .join(" | ");
    if (joined) return joined;
  }

  // 3) Sometimes providers place text under provider-specific fields
  // (rare in v5, but keep a safety)
  const provider = normalizeProvider(item?.contentProvider || item?.provider);
  const maybe = item?.reviewerComment || item?.comment || item?.review;
  if (maybe && String(maybe).trim()) return String(maybe).trim();

  return ""; // no text found
}

// --- Build a public URL that agents can click (when Chatmeter gives one)
function buildPublicUrl(item) {
  // Chatmeter v5 usually supplies a provider review URL or their review portal URL
  // Typical fields we’ve seen in real payloads:
  //   item.reviewURL, item.publicUrl, item.portalUrl
  const first =
    item?.reviewURL ||
    item?.publicUrl ||
    item?.portalUrl ||
    "";

  return first ? String(first) : "";
}

function pickTextFromReview(r) {
  // 1) Direct common fields
  const direct = [
    r.text, r.reviewText, r.comment, r.body, r.content, r.message, r.review_body
  ].find(isGoodText);
  if (isGoodText(direct)) return String(direct).trim();

  // 2) reviewData[] style (Chatmeter often places survey/vendor text here)
  const rows = Array.isArray(r.reviewData) ? r.reviewData : (Array.isArray(r.data) ? r.data : []);
  for (const it of rows) {
    const key = String(it.name || it.key || '').toLowerCase();
    const val = it.value ?? it.text ?? it.detail ?? '';
    if (!isGoodText(val)) continue;
    if (/(comment|comments|review|review[_ ]?text|text|body|content|np_comment|free.*text|description)/.test(key)) {
      return String(val).trim();
    }
  }

  // 3) Nothing found
  return '';
}

function pickPublicUrl(r) {
  // Prefer public URL; otherwise use whatever is available
  return r.publicUrl || r.reviewURL || r.portalUrl || '';
}

// --- inside your handler loop where you build payload for /api/review-webhook ---
const payload = {
  id: id,
  provider: it.contentProvider || it.provider || '',
  locationId: it.locationId ?? '',
  locationName: it.locationName ?? inferLocName(it.locationId),
  rating: it.rating ?? 0,
  authorName: it.reviewerUserName || it.authorName || 'Reviewer',
  authorEmail: it.reviewerEmail || it.authorEmail || 'reviews@drivo.com',
  createdAt: it.reviewDate || it.createdAt || '',
  text: pickTextFromReview(it),                 // <- use new extractor
  publicUrl: pickPublicUrl(it),                 // <- stable link
  portalUrl: it.portalUrl || ''
};
// ... send payload to /api/review-webhook as before

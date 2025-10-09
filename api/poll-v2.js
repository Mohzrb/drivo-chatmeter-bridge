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

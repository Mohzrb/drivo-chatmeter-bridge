// /api/poll-v2.js (helper)
function getReviewTextFromCM(r) {
  const provider = (r.contentProvider || r.provider || "").toUpperCase();
  const data = Array.isArray(r.reviewData) ? r.reviewData : [];

  const val = (names) => {
    for (const n of names) {
      const hit = data.find(
        x => (x.name || x.fieldName || "").toLowerCase() === n.toLowerCase()
      );
      if (hit && hit.value) return String(hit.value);
    }
    return "";
  };

  // start with generic/common keys
  let text =
    val(["np_reviewContent", "reviewContent", "np_comment", "comment"]) ||
    r.text ||
    "";

  // --- YELP: pull text from Yelp-specific fields (this is the bit you asked for)
  if (provider === "YELP") {
    text =
      val(["np_reviewText", "reviewText", "np_comment", "comment"]) || text;
  }

  // Other providers we covered (kept here for completeness)
  if (provider === "GOOGLE") {
    text = val(["np_reviewComment", "review_comment", "comment"]) || text;
  }

  if (provider === "TRUSTPILOT") {
    text = val(["np_reviewText", "reviewText", "comment"]) || text;
  }

  if (provider === "REVIEWBUILDER") {
    // free-form answer from survey-style reviews
    text = val(["open_text", "free_text", "comment"]) || text;
  }

  return (text || "").trim();
}

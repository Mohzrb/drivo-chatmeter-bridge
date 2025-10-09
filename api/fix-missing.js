/* -------------- robust human text extractor (v3) -------------- */
function extractBestText(item) {
  const candidates = [];
  const preferred = []; // keys that look like comment/free-text

  const pushIfGood = (raw, keyHint = "") => {
    if (raw == null) return;
    if (typeof raw !== "string") return;
    const s0 = raw.trim();
    if (!s0) return;

    // If value looks base64url, try to decode once
    const decoded = looksLikeBase64Url(s0) ? (tryBase64UrlDecode(s0).trim() || s0) : s0;

    // Hard filters: booleans, “0/1”, short tokens, control chars, no letters, etc.
    if (!isHumanText(decoded)) return;

    const hint = String(keyHint || "").toLowerCase();
    const isPreferredKey = /(own\s*words|comment|comments|describe|review|free[_\s-]?text|feedback|explain)/i.test(hint);

    (isPreferredKey ? preferred : candidates).push(decoded);
  };

  // 1) ReviewBuilder / survey pairs first (so key hints are preserved)
  if (Array.isArray(item.reviewData)) {
    for (const p of item.reviewData) {
      const key = String(p?.name || "").toLowerCase();
      const val = p?.value;

      if (typeof val === "string") pushIfGood(val, key);
      else if (val && typeof val === "object" && typeof val.value === "string") pushIfGood(val.value, key);
    }
  }

  // 2) Common top-level fields (no key hints here)
  [
    item.text, item.reviewText, item.body, item.comment, item.content,
    item.review, item.reviewerComments, item.providerReviewText,
    item.freeText, item.free_text, item.nps_comment, item.np_comments
  ].forEach(v => pushIfGood(v));

  // 3) Other survey shapes
  if (Array.isArray(item.surveyQuestions)) {
    for (const q of item.surveyQuestions) {
      const key = q?.question || q?.label || "";
      const ans = q?.answer ?? q?.value ?? q?.text;
      if (typeof ans === "string") pushIfGood(ans, key);
    }
  }
  if (Array.isArray(item.answers)) {
    for (const a of item.answers) {
      const key = a?.question || a?.label || "";
      const ans = a?.value ?? a?.text ?? "";
      if (typeof ans === "string") pushIfGood(ans, key);
    }
  }

  const pick = (arr) => {
    if (!arr.length) return null;
    // Prefer multi-word first; otherwise longest
    arr.sort((a, b) => {
      const aw = wordinessScore(a), bw = wordinessScore(b);
      if (bw !== aw) return bw - aw;
      return b.length - a.length;
    });
    return arr[0];
  };

  return pick(preferred) || pick(candidates) || "(no text)";
}

function wordinessScore(s) {
  // Crude: words with spaces > long single token
  const spaces = (s.match(/\s+/g) || []).length;
  return Math.min(10, spaces) + Math.min(10, Math.floor(s.length / 40));
}

function looksLikeBase64Url(str) {
  return typeof str === "string" && /^[A-Za-z0-9\-_]{30,}$/.test(str);
}
function tryBase64UrlDecode(str) {
  try {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4; if (pad) b64 += "=".repeat(4 - pad);
    return Buffer.from(b64, "base64").toString("utf8");
  } catch { return ""; }
}
function isHumanText(s) {
  if (!s) return false;
  const t = s.trim();

  // Reject pure booleans / binary / trivial
  if (/^(true|false|yes|no)$/i.test(t)) return false;
  if (/^[01]$/.test(t)) return false;

  // Must contain letters from any locale
  if (!/\p{L}/u.test(t)) return false;

  // Require either >= 8 chars OR has whitespace (multi-word)
  if (t.length < 8 && !/\s/.test(t)) return false;

  // Not only punctuation/digits/underscores
  if (/^[\d\W_]+$/.test(t)) return false;

  // No control chars
  if (/[\u0000-\u0008\u000E-\u001F]/.test(t)) return false;

  return true;
}

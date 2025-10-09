// /api/fix-missing.js
// Re-poll recent Chatmeter reviews and re-post to /api/review-webhook ONLY to fix missing text
// Requires Authorization: Bearer <CRON_SECRET>

/* ---------------------- HUMAN TEXT EXTRACTOR (v3) ---------------------- */
function extractBestText(item) {
  const candidates = [];
  const preferred = [];
  const pushIfGood = (raw, keyHint = "") => {
    if (raw == null) return;
    if (typeof raw !== "string") return;
    const s0 = raw.trim();
    if (!s0) return;
    const decoded = looksLikeBase64Url(s0) ? (tryBase64UrlDecode(s0).trim() || s0) : s0;
    if (!isHumanText(decoded)) return;
    const hint = String(keyHint || "").toLowerCase();
    const isPreferredKey = /(own\s*words|comment|comments|describe|review|free[_\s-]?text|feedback|explain)/i.test(hint);
    (isPreferredKey ? preferred : candidates).push(decoded);
  };

  if (Array.isArray(item.reviewData)) {
    for (const p of item.reviewData) {
      const key = String(p?.name || "").toLowerCase();
      const val = p?.value;
      if (typeof val === "string") pushIfGood(val, key);
      else if (val && typeof val === "object" && typeof val.value === "string") pushIfGood(val.value, key);
    }
  }

  [
    item.text, item.reviewText, item.body, item.comment, item.content,
    item.review, item.reviewerComments, item.providerReviewText,
    item.freeText, item.free_text, item.nps_comment, item.np_comments
  ].forEach(v => pushIfGood(v));

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
  if (/^(true|false|yes|no)$/i.test(t)) return false;
  if (/^[01]$/.test(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (t.length < 8 && !/\s/.test(t)) return false;
  if (/^[\d\W_]+$/.test(t)) return false;
  if (/[\u0000-\u0008\u000E-\u001F]/.test(t)) return false;
  return true;
}
/* ---------------------------------------------------------------------- */

export default async function handler(req, res) {
  const want = process.env.CRON_SECRET || "";
  const got = req.headers?.authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok:false, error:"Unauthorized", version:"fix-missing-2025-10-09" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const SELF_BASE = process.env.SELF_BASE_URL;

  if (!CHM_TOKEN || !SELF_BASE) {
    return res.status(500).json({ ok:false, error:"Missing env CHATMETER_V5_TOKEN or SELF_BASE_URL" });
  }

  try {
    const urlMinutes = Number(req.query.minutes || 2880); // 48h default
    const limit      = Number(req.query.limit || 200);
    const accountId  = req.query.accountId || process.env.CHM_ACCOUNT_ID || "";
    const sinceIso   = new Date(Date.now() - urlMinutes * 60 * 1000).toISOString();

    const qs = new URLSearchParams({
      updatedSince: sinceIso,
      limit: String(Math.min(200, Math.max(1, limit))),
      sortField: "reviewDate",
      sortOrder: "DESC"
    });
    if (accountId) qs.set("accountId", accountId);

    const listUrl = `${CHM_BASE}/reviews?${qs.toString()}`;
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) return res.status(502).json({ ok:false, error:`Chatmeter ${r.status}`, body:txt?.slice(0,500) });

    const json = safeJson(txt, {});
    const arr  = Array.isArray(json?.reviews) ? json.reviews :
                 Array.isArray(json?.results) ? json.results :
                 Array.isArray(json) ? json : [];

    let checked = 0, fixed = 0, skipped = 0, errors = 0;

    for (const it of arr) {
      if (checked >= limit) break;
      checked++;

      const id = it?.id || it?.reviewId || it?.providerReviewId || it?.review_id;
      if (!id) { skipped++; continue; }

      const text = extractBestText(it);
      if (!text || text === "(no text)") { skipped++; continue; }

      // Send to webhook in "repair mode": the webhook should update the existing ticket content but
      // avoid adding extra internal notes if it already has text.
      try {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook?repair=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: String(id),
            provider: it?.contentProvider || it?.provider || "",
            locationId: it?.locationId ? String(it.locationId) : "",
            locationName: it?.locationName || "",
            rating: Number(it?.rating || it?.score || 0),
            authorName: it?.reviewerUserName || it?.reviewer || it?.authorName || "",
            authorEmail: it?.reviewerEmail || it?.authorEmail || "",
            createdAt: it?.reviewDate || it?.createdAt || new Date().toISOString(),
            text,
            publicUrl: it?.reviewURL || it?.publicUrl || it?.url || "",
            portalUrl:  it?.portalUrl  || ""
          })
        });
        if (!resp.ok) { errors++; continue; }
        fixed++;
      } catch { errors++; }
    }

    return res.json({ ok:true, since: sinceIso, checked, fixed, skipped, errors });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

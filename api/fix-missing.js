// api/fix-missing.js
//
// Re-poll a window and re-send to /api/review-webhook
// (no duplicate internal cards are added by /api/review-webhook)
//
// GET /api/fix-missing?minutes=4320&limit=200
// Header: Authorization: Bearer <CRON_SECRET>

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    const want = process.env.CRON_SECRET || "";
    const got = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) return res.status(401).json({ ok:false, error:"Unauthorized" });

    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    const SELF_BASE = process.env.SELF_BASE_URL || `https://${req?.headers?.host}`;
    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");

    const q = req.query || {};
    const minutes = clampInt(q.minutes, 60, 43200, 4320);
    const limit   = clampInt(q.limit, 1, 500, 200);

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const url = new URL(`${CHM_BASE}/reviews`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sortField", "reviewDate");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("updatedSince", sinceIso);

    const r = await fetch(url.toString(), { headers: { Authorization: CHM_TOKEN }});
    const txt = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter error: ${r.status} ${txt}`);

    const data = safeJson(txt, {});
    const items = Array.isArray(data?.reviews) ? data.reviews : (Array.isArray(data) ? data : []);

    let checked = 0, fixed = 0, skipped = 0, errors = 0;
    for (const it of items) {
      checked++;
      const id = getReviewId(it);
      if (!id) { skipped++; continue; }

      const payload = toBridgePayload(it, id);

      try {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });
        if (resp.ok) fixed++; else errors++;
      } catch { errors++; }
    }

    return res.status(200).json({ ok:true, since: sinceIso, checked, fixed, skipped, errors });

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* --- share tiny helpers (dup to keep file standalone) --- */
function clampInt(v,min,max,def){ const n=parseInt(v,10); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def; }
function safeJson(s,fb){ try{return JSON.parse(s);}catch{return fb;} }
function getReviewId(it){ return it?.id || it?.reviewId || it?.review_id || it?.providerReviewId || null; }
function toInt(v, fb){ const n = parseInt(v,10); return Number.isFinite(n)?n:fb; }

function toBridgePayload(it, reviewId) {
  const rating = toInt(it?.rating, 0);
  const provider = String(it?.contentProvider || it?.provider || it?.source || "").toUpperCase() || "UNKNOWN";
  const author = it?.reviewerUserName || it?.reviewer || it?.authorName || it?.customerName || "Reviewer";
  const email  = it?.reviewerEmail || it?.email || "";
  const createdAt =
    it?.reviewDate || it?.createdAt || it?.created_at || new Date().toISOString();

  const text = extractBestText(it);
  const publicUrl = it?.reviewURL || it?.publicUrl || it?.portalUrl || "";
  const locationId   = String(it?.locationId || "");
  const locationName = String(it?.locationName || "");

  return {
    id: String(reviewId),
    provider,
    rating,
    authorName: String(author),
    authorEmail: String(email),
    createdAt: String(createdAt),
    text,
    publicUrl: String(publicUrl),
    locationId,
    locationName
  };
}

/* --- same extractor as poll-v2 --- */
function extractBestText(item) {
  const candidates = [];
  const pushIfText = (v) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    const dec = looksLikeBase64Url(s) ? tryBase64UrlDecode(s).trim() || s : s;
    if (isHumanText(dec)) candidates.push(dec);
  };
  [
    item.text, item.reviewText, item.body, item.comment, item.content,
    item.review, item.reviewerComments, item.providerReviewText,
    item.freeText, item.free_text, item.nps_comment, item.np_comments
  ].forEach(pushIfText);

  if (Array.isArray(item.reviewData)) {
    for (const p of item.reviewData) {
      const key = String(p?.name || "").toLowerCase().replace(/[\s\-]/g, "_");
      const val = p?.value;
      const isLikelyTextKey = /(comment|comments|review|free[_]?text|text|nps|np)/.test(key);
      if (typeof val === "string") {
        if (isLikelyTextKey) pushIfText(val);
        else if (isHumanText(val)) candidates.push(val.trim());
      } else if (val && typeof val === "object" && typeof val.value === "string") {
        const vv = val.value;
        if (isLikelyTextKey) pushIfText(vv);
        else if (isHumanText(vv)) candidates.push(vv.trim());
      }
    }
  }

  if (Array.isArray(item.surveyQuestions)) {
    for (const q of item.surveyQuestions) {
      const ans = q?.answer ?? q?.value ?? q?.text;
      pushIfText(String(ans || ""));
    }
  }
  if (Array.isArray(item.answers)) {
    for (const a of item.answers) pushIfText(String(a?.value ?? a?.text ?? ""));
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }
  return "(no text)";
}
function looksLikeBase64Url(str){ return typeof str==="string" && /^[A-Za-z0-9\-_]{30,}$/.test(str); }
function tryBase64UrlDecode(str){ try{ let b64=str.replace(/-/g,"+").replace(/_/g,"/"); const pad=b64.length%4; if(pad)b64+="=".repeat(4-pad); return Buffer.from(b64,"base64").toString("utf8"); }catch{ return ""; } }
function isHumanText(s){
  if(!s) return false;
  const t=s.trim();
  if(!/\p{L}/u.test(t)) return false;
  if(/^(true|false|yes|no)$/i.test(t)) return false;
  if(t.length<3) return false;
  if(/^[\d\W_]+$/.test(t)) return false;
  if(/[\u0000-\u0008\u000E-\u001F]/.test(t)) return false;
  return true;
}

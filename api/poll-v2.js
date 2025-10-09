// /api/poll-v2.js
// Poll Chatmeter v5 for recent reviews and create/refresh Zendesk tickets via /api/review-webhook
// Auth guard for Vercel Cron or manual runs via CRON_SECRET

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
  // guard
  const want = process.env.CRON_SECRET || "";
  const got = req.headers?.authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-09" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const SELF_BASE = process.env.SELF_BASE_URL;
  const DEFAULT_MIN = Number(process.env.POLLER_LOOKBACK_MINUTES || 60);

  if (!CHM_TOKEN || !SELF_BASE) {
    return res.status(500).json({ ok:false, error:"Missing env CHATMETER_V5_TOKEN or SELF_BASE_URL" });
  }

  try {
    const urlMinutes = Number(req.query.minutes || DEFAULT_MIN);
    const urlAccountId = req.query.accountId || process.env.CHM_ACCOUNT_ID || "";
    const urlClientId  = req.query.clientId  || process.env.CHM_CLIENT_ID  || "";
    const urlGroupId   = req.query.groupId   || "";
    const dry          = String(req.query.dry || "").toLowerCase() === "1";
    const maxItems     = Number(req.query.max || 50);

    const sinceIso = new Date(Date.now() - urlMinutes * 60 * 1000).toISOString();

    const qs = new URLSearchParams({
      updatedSince: sinceIso,
      limit: String(Math.min(100, Math.max(1, maxItems))),
      sortField: "reviewDate",
      sortOrder: "DESC"
    });
    if (urlAccountId) qs.set("accountId", urlAccountId);
    if (urlClientId)  qs.set("clientId",  urlClientId);
    if (urlGroupId)   qs.set("groupId",   urlGroupId);

    const listUrl = `${CHM_BASE}/reviews?${qs.toString()}`;
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const body = await r.text();
    if (!r.ok) return res.status(502).json({ ok:false, error:`Chatmeter ${r.status}`, body: body?.slice(0,500) });

    const json = safeJson(body, {});
    const arr  = Array.isArray(json?.reviews) ? json.reviews :
                 Array.isArray(json?.results) ? json.results :
                 Array.isArray(json) ? json : [];

    let posted = 0, skipped = 0, errors = 0, checked = 0;

    for (const it of arr) {
      if (checked >= maxItems) break;
      checked++;

      const id = it?.id || it?.reviewId || it?.providerReviewId || it?.review_id;
      if (!id) { skipped++; continue; }

      const provider = it?.contentProvider || it?.provider || "";
      const text = extractBestText(it);

      const payload = {
        id: String(id),
        provider: provider || "",
        locationId: it?.locationId ? String(it.locationId) : "",
        locationName: it?.locationName || "",
        rating: Number(it?.rating || it?.score || 0),
        authorName: it?.reviewerUserName || it?.reviewer || it?.authorName || "",
        authorEmail: it?.reviewerEmail || it?.authorEmail || "",
        createdAt: it?.reviewDate || it?.createdAt || new Date().toISOString(),
        text,
        publicUrl: it?.reviewURL || it?.publicUrl || it?.url || "",
        portalUrl:  it?.portalUrl  || ""
      };

      if (!dry) {
        try {
          const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!resp.ok) { errors++; continue; }
          posted++;
        } catch { errors++; }
      }
    }

    return res.json({
      ok: true,
      version: "poller-v2-2025-10-09",
      echo: { minutes: urlMinutes, clientId: urlClientId, accountId: urlAccountId, groupId: urlGroupId, dry, maxItems },
      since: sinceIso,
      checked, posted, skipped, errors,
      debug: { url: listUrl }
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

// api/poll-v2.js
//
// Poll Chatmeter for recent reviews and forward each to /api/review-webhook.
// Deduping happens in /api/review-webhook by external_id.
//
// GET /api/poll-v2?minutes=1440&max=50&accountId=...&clientId=...&groupId=...&dry=0
// Header: Authorization: Bearer <CRON_SECRET>

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    // --- auth (cron) ---
    const want = process.env.CRON_SECRET || "";
    const got = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-08" });
    }

    // --- env ---
    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    const SELF_BASE = process.env.SELF_BASE_URL || `https://${req?.headers?.host}`;

    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");

    // --- inputs ---
    const q = req.query || {};
    const minutes   = clampInt(q.minutes, 60, 43200, 1440);
    const max       = clampInt(q.max, 1, 200, 50);
    const clientId  = str(q.clientId);
    const accountId = str(q.accountId);
    const groupId   = str(q.groupId);
    const dry       = toBool(q.dry);

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const url = new URL(`${CHM_BASE}/reviews`);
    url.searchParams.set("limit", String(max));
    url.searchParams.set("sortField", "reviewDate");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("updatedSince", sinceIso);
    if (clientId)  url.searchParams.set("clientId", clientId);
    if (accountId) url.searchParams.set("accountId", accountId);
    if (groupId)   url.searchParams.set("groupId", groupId);

    const r = await fetch(url.toString(), { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter error: ${r.status} ${txt}`);
    const data = safeJson(txt, {});
    const items = Array.isArray(data?.reviews) ? data.reviews : (Array.isArray(data) ? data : []);

    let posted = 0, errors = 0, skipped = 0;
    for (const it of items) {
      const reviewId = getReviewId(it);
      if (!reviewId) { skipped++; continue; }

      const payload = toBridgePayload(it, reviewId);

      if (dry) { posted++; continue; }

      try {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          errors++;
        } else {
          posted++;
        }
      } catch {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-08",
      echo: { minutes, clientId, accountId, groupId, dry, maxItems: max },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors
    });

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------------- helpers ---------------- */

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
function str(v){ return (typeof v === "string" && v.trim()) ? v.trim() : ""; }
function toBool(v){ return String(v).toLowerCase() === "1" || String(v).toLowerCase() === "true"; }
function safeJson(s, fb){ try { return JSON.parse(s); } catch { return fb; } }

function getReviewId(it) {
  return it?.id || it?.reviewId || it?.review_id || it?.providerReviewId || null;
}

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

function toInt(v, fb){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; }

/* -------------- robust human text extractor (v2) -------------- */
function extractBestText(item) {
  const candidates = [];

  const pushIfText = (v) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    const dec = looksLikeBase64Url(s) ? tryBase64UrlDecode(s).trim() || s : s;
    if (isHumanText(dec)) candidates.push(dec);
  };

  // 1) Common top-level fields
  [
    item.text, item.reviewText, item.body, item.comment, item.content,
    item.review, item.reviewerComments, item.providerReviewText,
    item.freeText, item.free_text, item.nps_comment, item.np_comments
  ].forEach(pushIfText);

  // 2) ReviewBuilder / survey pairs
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

  // 3) Some NPS/Survey shapes
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
  if (!/\p{L}/u.test(t)) return false;
  if (/^(true|false|yes|no)$/i.test(t)) return false;
  if (t.length < 3) return false;
  if (/^[\d\W_]+$/.test(t)) return false;
  if (/[\u0000-\u0008\u000E-\u001F]/.test(t)) return false;
  return true;
}

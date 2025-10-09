// /api/poll-v2.js
// Poll Chatmeter for recent reviews and forward to /api/review-webhook.
// Strong text extraction; handles Google/Yelp/Trustpilot/Facebook/Bing/ReviewBuilder.

export const config = { runtime: "nodejs" };

// ---------- Helpers ----------
function isGoodText(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  // Avoid printing IDs as comments (24-char hex kind of strings)
  if (/^[a-f0-9]{24}$/i.test(s)) return false;
  return true;
}

function pickTextFromReview(r) {
  // 1) direct fields
  const direct = [
    r.text, r.reviewText, r.comment, r.body, r.content, r.message, r.review_body
  ].find(isGoodText);
  if (isGoodText(direct)) return String(direct).trim();

  // 2) reviewData[] or data[]
  const rows = Array.isArray(r.reviewData) ? r.reviewData
             : Array.isArray(r.data)       ? r.data
             : [];
  for (const it of rows) {
    const key = String(it.name || it.key || "").toLowerCase();
    const val = it.value ?? it.text ?? it.detail ?? "";
    if (!isGoodText(val)) continue;
    if (/(comment|comments|review|review[_ ]?text|text|body|content|np_comment|free.*text|description)/.test(key)) {
      return String(val).trim();
    }
  }
  return "";
}

function pickPublicUrl(r) {
  return r.publicUrl || r.reviewURL || r.portalUrl || "";
}

function inferLocName(id) {
  try {
    const map = JSON.parse(process.env.CHM_LOCATION_MAP || "{}");
    return map?.[String(id)] || "";
  } catch {
    return "";
  }
}

function toInt(v, fb) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fb;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Cron protection
  const want = process.env.CRON_SECRET || "";
  const got  = req.headers.authorization || req.headers.Authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const SELF_BASE = process.env.SELF_BASE_URL;

  if (!CHM_TOKEN || !SELF_BASE) {
    return res.status(500).json({
      ok: false,
      error: "Missing env CHATMETER_V5_TOKEN or SELF_BASE_URL"
    });
  }

  const minutes = toInt(req.query.minutes || process.env.POLLER_LOOKBACK_MINUTES || "1440", 1440);
  const max     = Math.min(500, toInt(req.query.max || "50", 50));
  const accountId = (req.query.accountId || process.env.CHM_ACCOUNT_ID || "").trim();
  const clientId  = (req.query.clientId  || "").trim();
  const groupId   = (req.query.groupId   || "").trim();
  const dryRun    = (String(req.query.dry || "0") === "1");

  const sinceIso  = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // Build Chatmeter list URL
  const qs = new URLSearchParams({
    limit: String(max),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso
  });
  if (accountId) qs.set("accountId", accountId);
  if (clientId)  qs.set("clientId", clientId);
  if (groupId)   qs.set("groupId", groupId);

  const url = `${CHM_BASE}/reviews?${qs.toString()}`;

  let checked = 0, posted = 0, skipped = 0, errors = 0;

  try {
    const r = await fetch(url, { headers: { Authorization: CHM_TOKEN } });
    const text = await r.text();
    if (!r.ok) return res.status(502).send(text);

    const data = JSON.parse(text || "{}");
    const items = Array.isArray(data.reviews) ? data.reviews : (data.results || []);

    for (const it of items) {
      checked++;

      const id =
        it?.id || it?.reviewId || it?.review_id || it?.providerReviewId || "";
      if (!id) { skipped++; continue; }

      const payload = {
        id,
        provider: it.contentProvider || it.provider || "",
        locationId: it.locationId ?? "",
        locationName: it.locationName || inferLocName(it.locationId),
        rating: it.rating ?? 0,
        authorName: it.reviewerUserName || it.authorName || "Reviewer",
        authorEmail: it.reviewerEmail || it.authorEmail || "reviews@drivo.com",
        createdAt: it.reviewDate || it.createdAt || "",
        text: pickTextFromReview(it),
        publicUrl: pickPublicUrl(it)
      };

      if (dryRun) {
        posted++; // simulate
        continue;
      }

      try {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) { errors++; continue; }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.json({
      ok: true,
      since: sinceIso,
      checked, posted, skipped, errors,
      echo: {
        rawUrl: req.url,
        minutes,
        accountId, clientId, groupId,
        dry: dryRun
      },
      version: "poller-v2-2025-10-09"
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

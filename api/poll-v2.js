// api/poll-v2.js
//
// Chatmeter → (this poller) → /api/review-webhook → Zendesk ticket
//
// Query params:
//   minutes   : lookback window in minutes (default 60)
//   accountId : Chatmeter accountId (optional; falls back to CHM_ACCOUNT_ID)
//   clientId  : Chatmeter clientId (optional)
//   groupId   : Chatmeter groupId (optional)
//   max       : max items to fetch (default 50, cap 200)
//   dry       : if present and truthy, do not call /api/review-webhook (debug only)
//
// Auth:
//   If process.env.CRON_SECRET is set, caller must send
//     Authorization: Bearer <CRON_SECRET>

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).send("Method Not Allowed");
    }

    // --- Auth (allow local/test calls if CRON_SECRET not set)
    const want = process.env.CRON_SECRET;
    const got =
      req.headers.authorization ||
      req.headers.Authorization ||
      "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-09" });
    }

    // --- ENV
    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;        // raw token (no "Bearer")
    const SELF_BASE = process.env.SELF_BASE_URL || "";       // e.g., https://drivo-chatmeter-bridge.vercel.app
    const DEF_ACCT  = process.env.CHM_ACCOUNT_ID || "";      // optional default accountId
    const LOC_MAP   = safeParse(process.env.CHM_LOCATION_MAP || "{}", {});

    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");
    if (!SELF_BASE) return res.status(500).send("Missing env: SELF_BASE_URL");

    // --- Query options
    const q = req.query || {};
    const minutes  = clampInt(q.minutes, 60, 5, 43200); // default 60m, min 5m, max 30d
    const clientId = (q.clientId || "").toString().trim();
    const accountId= ((q.accountId || DEF_ACCT) || "").toString().trim();
    const groupId  = (q.groupId || "").toString().trim();
    const max      = clampInt(q.max, 50, 1, 200);
    const dryRun   = isTruthy(q.dry);

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // --- Build Chatmeter list URL
    const params = new URLSearchParams({
      limit: String(max),
      sortField: "reviewDate",
      sortOrder: "DESC",
      updatedSince: sinceIso
    });
    if (clientId)  params.set("clientId",  clientId);
    if (accountId) params.set("accountId", accountId);
    if (groupId)   params.set("groupId",   groupId);

    const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;

    // --- Fetch from Chatmeter
    const chmRes = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const chmTxt = await chmRes.text();
    if (!chmRes.ok) {
      return res.status(502).json({
        ok: false,
        error: `Chatmeter list error ${chmRes.status}`,
        body_snippet: chmTxt.slice(0, 400),
        version: "poller-v2-2025-10-09"
      });
    }

    const parsed = safeParse(chmTxt, {});
    const items =
      Array.isArray(parsed) ? parsed :
      Array.isArray(parsed?.results) ? parsed.results :
      Array.isArray(parsed?.reviews) ? parsed.reviews : [];

    let posted = 0, skipped = 0, errors = 0;

    for (const it of items) {
      const id =
        it?.id ||
        it?.reviewId ||
        it?.review_id ||
        it?.providerReviewId ||
        null;

      if (!id) { skipped++; continue; }

      // Normalize provider / text / url
      const provider = normalizeProvider(it?.contentProvider || it?.provider || "");
      const text     = extractReviewText(it);
      const link     = buildPublicUrl(it);

      // Optional: map locationName from env map if available
      const locName = it?.locationName ||
                      LOC_MAP[String(it?.locationId)] ||
                      "Unknown";

      // Construct payload for /api/review-webhook
      const payload = {
        id:           String(id),
        provider:     provider,                     // GOOGLE/YELP/TRUSTPILOT/FACEBOOK/BING/REVIEWBUILDER/SURVEYS…
        locationId:   String(it?.locationId || ""),
        locationName: String(locName),
        rating:       Number(it?.rating || 0),
        authorName:   it?.reviewerUserName || it?.authorName || "Reviewer",
        createdAt:    it?.reviewDate || it?.createdAt || "",
        text:         text || "",
        publicUrl:    link || ""
      };

      try {
        if (!dryRun) {
          const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!resp.ok) {
            errors++;
            continue;
          }
        }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-09",
      echo: {
        minutes,
        clientId,
        accountId,
        groupId,
        dry: dryRun,
        maxItems: max
      },
      since: sinceIso,
      checked: items.length,
      posted,
      skipped,
      errors,
      debug: {
        url: listUrl,
        body_snippet: chmTxt.slice(0, 400)
      }
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      version: "poller-v2-2025-10-09"
    });
  }
}

/* ----------------------- helpers ----------------------- */

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  return def;
}
function isTruthy(v) {
  if (v === true) return true;
  const s = (v || "").toString().toLowerCase();
  return ["1","true","yes","y","on"].includes(s);
}

// Normalize provider labels to stable set
function normalizeProvider(p) {
  const v = (p || "").toString().trim().toUpperCase();
  if (!v) return "";

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

  return MAP[v] || v; // default to upper-case source if unmapped
}

// Extract human review text across providers (incl. surveys)
function extractReviewText(item) {
  // 1) If Chatmeter already put text here
  if (item?.text && String(item.text).trim()) return String(item.text).trim();

  // 2) Survey/ReviewBuilder answers often in reviewData
  const data = Array.isArray(item?.reviewData) ? item.reviewData : [];
  if (data.length) {
    const KEYS = ["nptext", "freeformanswer", "freeform", "comment", "text", "reviewtext"];

    for (const d of data) {
      const name = (d?.name || "").toString().toLowerCase();
      if (KEYS.includes(name) && d?.value && String(d.value).trim()) {
        return String(d.value).trim();
      }
    }

    const joined = data
      .map(d => d?.value)
      .filter(v => v && String(v).trim())
      .join(" | ");
    if (joined) return joined;
  }

  // 3) Some providers may place under other fields
  const maybe = item?.reviewerComment || item?.comment || item?.review;
  if (maybe && String(maybe).trim()) return String(maybe).trim();

  return "";
}

// Build a viewable link when Chatmeter provides one
function buildPublicUrl(item) {
  const url = item?.reviewURL || item?.publicUrl || item?.portalUrl || "";
  return url ? String(url) : "";
}

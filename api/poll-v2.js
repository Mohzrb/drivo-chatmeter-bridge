// Poll Chatmeter (v5) and forward each review to /api/review-webhook
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;  // raw token (no "Bearer")
  const SELF_BASE = process.env.SELF_BASE_URL || ""; // e.g., https://drivo-chatmeter-bridge.vercel.app
  const DEF_MIN   = Number(process.env.POLLER_LOOKBACK_MINUTES || 1440); // default 24h
  const CHM_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || ""; // optional
  const CRON_SECRET    = process.env.CRON_SECRET || "";    // optional

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !SELF_BASE && "SELF_BASE_URL",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // Optional auth for Vercel Cron (if you set CRON_SECRET)
  const hdr = req.headers?.authorization || req.headers?.Authorization || "";
  if (CRON_SECRET && hdr !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-07" });
  }

  try {
    const urlObj = new URL(req.url, "http://x");
    const minutes = Number(urlObj.searchParams.get("minutes") || DEF_MIN);
    const clientId  = urlObj.searchParams.get("clientId") || "";
    const accountId = urlObj.searchParams.get("accountId") || CHM_ACCOUNT_ID;
    const groupId   = urlObj.searchParams.get("groupId") || "";
    const maxItems  = Number(urlObj.searchParams.get("max") || 50);
    const sinceIso  = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const q = new URLSearchParams({
      limit: String(maxItems),
      sortField: "reviewDate",
      sortOrder: "DESC",
      updatedSince: sinceIso
    });
    if (clientId) q.set("clientId", clientId);
    if (accountId) q.set("accountId", accountId);
    if (groupId) q.set("groupId", groupId);

    const listUrl = `${CHM_BASE}/reviews?${q.toString()}`;
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const text = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter list error: ${r.status} ${text}`);

    const data = safeParse(text, {});
    const items = Array.isArray(data.reviews) ? data.reviews : (data.results || []);
    let posted = 0, skipped = 0, errors = 0;

    for (const it of items) {
      const payload = normalizeReview(it);
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

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-07",
      echo: {
        rawUrl: urlObj.pathname + urlObj.search,
        urlMinutes: String(minutes),
        urlClientId: clientId || null,
        urlAccountId: accountId || null,
        urlGroupId: groupId || null
      },
      since: sinceIso,
      lookback_minutes: minutes,
      checked: items.length,
      posted, skipped, errors
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------- helpers ---------- */

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

function normalizeReview(r) {
  // provider & free text extraction
  const provider = (r.contentProvider || r.provider || "").toUpperCase();
  const text = getReviewTextFromCM(r);

  // location label from optional env map
  let LOC_MAP = {};
  try { if (process.env.CHM_LOCATION_MAP) LOC_MAP = JSON.parse(process.env.CHM_LOCATION_MAP); } catch {}
  const locLabel = LOC_MAP[r.locationId] || r.locationName || "Unknown";

  const author = r.reviewerUserName || r.reviewerName || "Reviewer";
  return {
    id: r.id,
    provider,
    rating: r.rating ?? 0,
    locationId: r.locationId,
    locationName: locLabel,
    authorName: author,
    createdAt: r.reviewDate || r.createdAt,
    text,
    publicUrl: r.reviewURL || r.publicUrl || ""
  };
}

// provider-aware text extraction (includes Yelp branch)
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

  let text =
    val(["np_reviewContent", "reviewContent", "np_comment", "comment"]) ||
    r.text ||
    "";

  if (provider === "YELP") {
    text = val(["np_reviewText", "reviewText", "np_comment", "comment"]) || text;
  }
  if (provider === "GOOGLE") {
    text = val(["np_reviewComment", "review_comment", "comment"]) || text;
  }
  if (provider === "TRUSTPILOT") {
    text = val(["np_reviewText", "reviewText", "comment"]) || text;
  }
  if (provider === "REVIEWBUILDER") {
    text = val(["open_text", "free_text", "comment"]) || text;
  }

  return (text || "").trim();
}

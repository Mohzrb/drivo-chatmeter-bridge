// Poll Chatmeter for recent reviews and forward each to /api/review-webhook
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const {
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID,                  // optional default
    CHM_LOCATION_MAP,                // optional JSON { "1001":"JFK", ... }
    SELF_BASE_URL,                   // optional (falls back to req.headers.host)
    CRON_SECRET                      // required if you want to protect this endpoint
  } = process.env;

  // Require CRON_SECRET unless explicitly running without it
  const gotAuth = req.headers.authorization || req.headers.Authorization || "";
  if (CRON_SECRET && gotAuth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version });
  }

  const urlObj = new URL(req.url, "http://localhost"); // not used for host, only for query parsing
  const q = Object.fromEntries(urlObj.searchParams.entries());

  const minutes   = Number(q.minutes || q.m || 15);
  const clientId  = (q.clientId || "").trim();
  const accountId = (q.accountId || CHM_ACCOUNT_ID || "").trim();
  const groupId   = (q.groupId || "").trim();
  const providers = (q.providers || "").trim();          // e.g. GOOGLE or GOOGLE,YELP
  const maxItems  = Math.min(Number(q.max || 50), 50);   // safety cap
  const dryRun    = q.dry === "1" || q.dry === "true";

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const BASE = CHATMETER_V5_BASE;
  const TOKEN = CHATMETER_V5_TOKEN;

  if (!TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");

  const host = SELF_BASE_URL || `https://${req.headers.host}`;
  const forwardTo = `${host}/api/review-webhook`;

  // Provider families that often need detail calls to get the comment text
  const ALWAYS_DETAIL_PROVIDERS = new Set(["GOOGLE","YELP","TRUSTPILOT","FACEBOOK","BING","MICROSOFT"]);

  // Parse mapping
  let LOCATION_MAP = {};
  try { LOCATION_MAP = CHM_LOCATION_MAP ? JSON.parse(CHM_LOCATION_MAP) : {}; } catch {}

  const version = "poller-v2-ultrasafe+surveytext-2025-10-07";

  const params = new URLSearchParams({
    limit: String(maxItems),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso
  });
  if (clientId)  params.set("clientId", clientId);
  if (accountId) params.set("accountId", accountId);
  if (groupId)   params.set("groupId", groupId);
  if (providers) params.set("providers", providers);

  const listUrl = `${BASE}/reviews?${params.toString()}`;

  try {
    const listRes = await fetch(listUrl, { headers: { Authorization: TOKEN } });
    const listTxt = await listRes.text();
    if (!listRes.ok) return res.status(502).send(`Chatmeter list error: ${listRes.status} ${listTxt}`);

    const parsed = safeParse(listTxt, {});
    const items = Array.isArray(parsed?.reviews) ? parsed.reviews :
                  Array.isArray(parsed)           ? parsed :
                  Array.isArray(parsed?.results)  ? parsed.results : [];

    let posted = 0, skipped = 0, errors = 0;
    for (const r of items) {
      const id = r?.id || r?.reviewId || r?.review_id;
      if (!id) { skipped++; continue; }

      // Normalize provider
      let provider = String(r.contentProvider || r.provider || r.source || "").toUpperCase();
      if (provider.includes("MICROSOFT")) provider = "BING";

      // Text extraction
      let text = pickText(r);

      // Fetch detail if we must or if text is empty
      if (!text || ALWAYS_DETAIL_PROVIDERS.has(provider)) {
        try {
          const detRes = await fetch(`${BASE}/reviews/${encodeURIComponent(id)}`, {
            headers: { Authorization: TOKEN }
          });
          if (detRes.ok) {
            const det = await detRes.json().catch(() => ({}));
            text = pickText(det) || text;
          }
        } catch { /* ignore */ }
      }

      // Location name (prefer mapping, else payload, avoid numeric in the subject)
      const locationId = String(r.locationId || r.location_id || "");
      const locationName = LOCATION_MAP[locationId] || r.locationName || r.location || "Unknown";

      // Build the canonical payload we expect in /api/review-webhook
      const payload = {
        id,
        provider,
        locationId,
        locationName,
        rating: typeof r.rating === "number" ? r.rating : Number(r.rating || 0),
        authorName: r.reviewerUserName || r.authorName || r.reviewer || "Chatmeter Reviewer",
        createdAt: r.reviewDate || r.createdAt || r.date || "",
        text: text || "",
        publicUrl: r.reviewURL || r.publicUrl || "",
        portalUrl: r.portalUrl || ""
      };

      if (dryRun) { posted++; continue; }

      try {
        const resp = await fetch(forwardTo, {
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
      version,
      echo: {
        rawUrl: `/api/poll-v2?${new URLSearchParams(q).toString()}`,
        minutes, clientId, accountId, groupId, dry: dryRun, maxItems
      },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors,
      debug: { url: listUrl, body_snippet: listTxt.slice(0, 180) }
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// -------- helpers --------
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

// Try very hard to find a human comment in any shape the API might return
function pickText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const val = v => (typeof v === "string" && v.trim()) ? v.trim() : "";

  // common direct fields
  const direct = val(obj.text) || val(obj.comment) || val(obj.body) ||
                 val(obj.reviewText) || val(obj.review_text) ||
                 val(obj.description) || val(obj.content) || val(obj.message);
  if (direct) return direct;

  // nested
  if (obj.review) {
    const fromReview = val(obj.review.text) || val(obj.review.body);
    if (fromReview) return fromReview;
  }

  // Survey/reviewBuilder style
  if (Array.isArray(obj.reviewData)) {
    const hit = obj.reviewData.find(x => x && /comment|text|review|feedback/i.test(x.name || ""));
    if (hit) {
      const fromRD = val(hit.value);
      if (fromRD) return fromRD;
    }
  }

  return "";
}

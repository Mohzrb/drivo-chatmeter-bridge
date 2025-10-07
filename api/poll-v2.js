// poller-v2 (debug + robust parsing): polls Chatmeter and forwards to /api/review-webhook
export default async function handler(req, res) {
  const VERSION = "poller-v2-2025-10-07";

  // Optional auth gate for scheduled callers (GitHub Actions / Zapier / Vercel Cron)
  const want = process.env.CRON_SECRET;
  const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: VERSION });
  }

  // Required env
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;    // raw token from POST /v5/login (no "Bearer")
  const SELF_BASE = process.env.SELF_BASE_URL;         // e.g. https://drivo-chatmeter-bridge.vercel.app

  // Defaults
  const LOOKBACK  = Number(process.env.POLLER_LOOKBACK_MINUTES || 15);

  // Optional env scopes for reseller/admin tokens
  const ENV_CLIENT_ID  = process.env.CHM_CLIENT_ID  || "";
  const ENV_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "";
  const ENV_GROUP_ID   = process.env.CHM_GROUP_ID   || "";

  const missing = [!CHM_TOKEN && "CHATMETER_V5_TOKEN", !SELF_BASE && "SELF_BASE_URL"].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(", ")}`, version: VERSION });
  }

  // Parse query overrides: ?minutes=43200&accountId=...&clientId=...&groupId=...
  let lookback = LOOKBACK;
  let clientId  = ENV_CLIENT_ID;
  let accountId = ENV_ACCOUNT_ID;
  let groupId   = ENV_GROUP_ID;

  const rawUrl = req.url || "";
  let urlMinutes = null, urlClientId = null, urlAccountId = null, urlGroupId = null;

  try {
    const u = new URL(rawUrl, `https://${req.headers.host}`);
    urlMinutes   = u.searchParams.get("minutes");
    urlClientId  = u.searchParams.get("clientId");
    urlAccountId = u.searchParams.get("accountId");
    urlGroupId   = u.searchParams.get("groupId");

    const m = Number(urlMinutes || "");
    if (Number.isFinite(m) && m > 0) lookback = m;
    if (urlClientId)  clientId  = urlClientId;
    if (urlAccountId) accountId = urlAccountId;
    if (urlGroupId)   groupId   = urlGroupId;
  } catch {}

  const sinceIso = new Date(Date.now() - lookback * 60 * 1000).toISOString();
  const endIso   = new Date().toISOString();

  // Build Chatmeter query
  let baseQuery = `limit=50&sortField=reviewDate&sortOrder=DESC`;
  if (clientId)  baseQuery += `&clientId=${encodeURIComponent(clientId)}`;
  if (accountId) baseQuery += `&accountId=${encodeURIComponent(accountId)}`;
  if (groupId)   baseQuery += `&groupId=${encodeURIComponent(groupId)}`;

  // Call 1: updatedSince (fast path)
  const url1 = `${CHM_BASE}/reviews?${baseQuery}&updatedSince=${encodeURIComponent(sinceIso)}`;
  const first = await fetchWithPeek(url1, CHM_TOKEN);

  // Fallback: explicit start/end
  let items = first.items;
  let second = null;
  if (!items.length) {
    const url2 = `${CHM_BASE}/reviews?${baseQuery}&startDate=${encodeURIComponent(sinceIso)}&endDate=${encodeURIComponent(endIso)}`;
    second = await fetchWithPeek(url2, CHM_TOKEN);
    items = second.items;
  }

  // Send each review to /api/review-webhook (creates Zendesk tickets)
  let posted = 0, skipped = 0, errors = 0;
  for (const it of items) {
    const id =
      it?.id ?? it?.reviewId ?? it?.review_id ?? it?.reviewID ?? it?.providerReviewId ?? null;
    if (!id) { skipped++; continue; }

    // Robust field mapping (handles multiple shapes)
    const payload = {
      id,
      locationId: it.locationId ?? it.location_id ?? it.providerLocationId ?? "",
      locationName: it.locationName ?? it.location_name ?? it.location ?? "Unknown",
      rating: it.rating ?? it.stars ?? it.score ?? 0,
      authorName: it.authorName ?? it.reviewerName ?? it.author ?? "Chatmeter Reviewer",
      createdAt: it.reviewDate ?? it.createdAt ?? it.date ?? it.createdOn ?? "",
      text: it.text ?? it.detail ?? it.body ?? it.reviewText ?? "",
      publicUrl: it.publicUrl ?? it.url ?? "",
      portalUrl: it.portalUrl ?? it.portal_url ?? ""
    };

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
    version: VERSION,
    echo: { rawUrl, urlMinutes, urlClientId, urlAccountId, urlGroupId },
    since: sinceIso,
    lookback_minutes: lookback,
    used_clientId:  clientId  || null,
    used_accountId: accountId || null,
    used_groupId:   groupId   || null,
    checked: items.length, posted, skipped, errors,
    debug: {
      first:  { url: first.url,  status: first.status,  ok: first.ok,  body_snippet: first.bodySnippet },
      second: second && { url: second.url, status: second.status, ok: second.ok, body_snippet: second.bodySnippet }
    }
  });
}

/* -------- helpers -------- */

async function fetchWithPeek(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: token } }); // raw token (no "Bearer")
    const txt = await r.text();
    const items = r.ok ? extractItems(txt) : [];
    return {
      url,
      status: r.status,
      ok: r.ok,
      bodySnippet: (txt || "").slice(0, 300),
      items
    };
  } catch (e) {
    return { url, status: 0, ok: false, bodySnippet: String(e), items: [] };
  }
}

function extractItems(txt) {
  const data = safeParse(txt, null);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.reviews)) return data.reviews;   // Chatmeter often responds with { reviews: [...] }
  if (Array.isArray(data.items))   return data.items;
  return [];
}

function safeParse(s, fb) {
  try { return JSON.parse(s); } catch { return fb; }
}

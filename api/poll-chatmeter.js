// Poll Chatmeter for recent reviews and forward each to /api/review-webhook
export default async function handler(req, res) {
  // Optional: lock to Vercel Cron with a secret
  const want = process.env.CRON_SECRET;
  const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
  if (want && got !== `Bearer ${want}`) return res.status(401).send("Unauthorized");

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;   // raw token (no "Bearer")
  const SELF_BASE = process.env.SELF_BASE_URL;        // e.g., https://drivo-chatmeter-bridge.vercel.app
  const LOOKBACK  = Number(process.env.POLLER_LOOKBACK_MINUTES || 15);

  // Support reseller scoping
  const ENV_CLIENT_ID  = process.env.CHM_CLIENT_ID  || "";
  const ENV_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || ""; // NEW
  const ENV_GROUP_ID   = process.env.CHM_GROUP_ID   || "";

  const missing = [!CHM_TOKEN && "CHATMETER_V5_TOKEN", !SELF_BASE && "SELF_BASE_URL"].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    // Allow URL overrides: /api/poll-chatmeter?minutes=43200&accountId=...&clientId=...&groupId=...
    let lookback = LOOKBACK;
    let clientId  = ENV_CLIENT_ID;
    let accountId = ENV_ACCOUNT_ID; // NEW
    let groupId   = ENV_GROUP_ID;

    try {
      const urlObj = new URL(req.url, `https://${req.headers.host}`);
      const m = Number(urlObj.searchParams.get("minutes") || "");
      if (Number.isFinite(m) && m > 0) lookback = m;
      clientId  = urlObj.searchParams.get("clientId")  || clientId;
      accountId = urlObj.searchParams.get("accountId") || accountId; // NEW
      groupId   = urlObj.searchParams.get("groupId")   || groupId;
    } catch {}

    const sinceIso = new Date(Date.now() - lookback * 60 * 1000).toISOString();
    const endIso   = new Date().toISOString();

    // Build query
    let baseQuery = `limit=50&sortField=reviewDate&sortOrder=DESC`;
    if (clientId)  baseQuery += `&clientId=${encodeURIComponent(clientId)}`;
    if (accountId) baseQuery += `&accountId=${encodeURIComponent(accountId)}`; // NEW
    if (groupId)   baseQuery += `&groupId=${encodeURIComponent(groupId)}`;

    // First: updatedSince
    const url1 = `${CHM_BASE}/reviews?${baseQuery}&updatedSince=${encodeURIComponent(sinceIso)}`;
    let items = await fetchJson(url1, CHM_TOKEN);

    // Fallback: start/end range
    if (!items.length) {
      const url2 = `${CHM_BASE}/reviews?${baseQuery}&startDate=${encodeURIComponent(sinceIso)}&endDate=${encodeURIComponent(endIso)}`;
      items = await fetchJson(url2, CHM_TOKEN);
    }

    let posted = 0, skipped = 0, errors = 0;
    for (const it of items) {
      const id = it?.id ?? it?.reviewId ?? it?.review_id ?? it?.reviewID ?? null;
      if (!id) { skipped++; continue; }

      const payload = {
        id,
        locationId: it.locationId ?? "",
        locationName: it.locationName ?? "Unknown",
        rating: it.rating ?? 0,
        authorName: it.authorName ?? "Chatmeter Reviewer",
        createdAt: it.reviewDate ?? it.createdAt ?? "",
        text: it.text ?? "",
        publicUrl: it.publicUrl ?? "",
        portalUrl: it.portalUrl ?? ""
      };

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

    return res.status(200).json({
      ok: true,
      since: sinceIso,
      lookback_minutes: lookback,
      used_clientId:  clientId  || null,
      used_accountId: accountId || null,  // helpful for debugging
      used_groupId:   groupId   || null,
      checked: items.length, posted, skipped, errors
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

async function fetchJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: token } }); // no "Bearer"
  const txt = await r.text();
  if (!r.ok) throw new Error(`Chatmeter list error: ${r.status} ${txt}`);
  const data = safeParse(txt, []);
  return Array.isArray(data) ? data : (data.results || []);
}
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

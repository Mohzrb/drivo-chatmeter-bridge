// poller-v2 (debug): echoes params + shows Chatmeter responses
export default async function handler(req, res) {
  const VERSION = "poller-v2-debug-2025-10-07";

  const want = process.env.CRON_SECRET;
  const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: VERSION });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;    // raw token only
  const SELF_BASE = process.env.SELF_BASE_URL;
  const LOOKBACK  = Number(process.env.POLLER_LOOKBACK_MINUTES || 15);

  const ENV_CLIENT_ID  = process.env.CHM_CLIENT_ID  || "";
  const ENV_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "";
  const ENV_GROUP_ID   = process.env.CHM_GROUP_ID   || "";

  const missing = [!CHM_TOKEN && "CHATMETER_V5_TOKEN", !SELF_BASE && "SELF_BASE_URL"].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(", ")}`, version: VERSION });
  }

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

  let baseQuery = `limit=50&sortField=reviewDate&sortOrder=DESC`;
  if (clientId)  baseQuery += `&clientId=${encodeURIComponent(clientId)}`;
  if (accountId) baseQuery += `&accountId=${encodeURIComponent(accountId)}`;
  if (groupId)   baseQuery += `&groupId=${encodeURIComponent(groupId)}`;

  const url1 = `${CHM_BASE}/reviews?${baseQuery}&updatedSince=${encodeURIComponent(sinceIso)}`;
  const first = await fetchWithPeek(url1, CHM_TOKEN);

  let items = first.items;
  let second = null;

  if (!items.length) {
    const url2 = `${CHM_BASE}/reviews?${baseQuery}&startDate=${encodeURIComponent(sinceIso)}&endDate=${encodeURIComponent(endIso)}`;
    second = await fetchWithPeek(url2, CHM_TOKEN);
    items = second.items;
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
    version: VERSION,
    echo: { rawUrl, urlMinutes, urlClientId, urlAccountId, urlGroupId },
    since: sinceIso,
    lookback_minutes: lookback,
    used_clientId:  clientId  || null,
    used_accountId: accountId || null,
    used_groupId:   groupId   || null,
    checked: items.length, posted, skipped, errors,
    debug: {
      first: {
        url: first.url, status: first.status, ok: first.ok,
        body_snippet: first.bodySnippet
      },
      second: second && {
        url: second.url, status: second.status, ok: second.ok,
        body_snippet: second.bodySnippet
      }
    }
  });
}

async function fetchWithPeek(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: token } });
    const txt = await r.text();
    let data = [];
    try {
      const parsed = JSON.parse(txt);
      data = Array.isArray(parsed) ? parsed : (parsed.results || []);
    } catch {}
    return {
      url,
      status: r.status,
      ok: r.ok,
      bodySnippet: (txt || "").slice(0, 300),
      items: data
    };
  } catch (e) {
    return { url, status: 0, ok: false, bodySnippet: String(e), items: [] };
  }
}

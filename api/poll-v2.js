// poller-v2 (enriched): robust text extraction + location name hydration + debug
export default async function handler(req, res) {
  const VERSION = "poller-v2-enriched-2025-10-07";

  // protect with CRON_SECRET if set
  const want = process.env.CRON_SECRET;
  const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: VERSION });
  }

  // required env
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;    // raw token (no "Bearer")
  const SELF_BASE = process.env.SELF_BASE_URL;         // e.g., https://drivo-chatmeter-bridge.vercel.app
  const LOOKBACK  = Number(process.env.POLLER_LOOKBACK_MINUTES || 15);

  // optional default scopes for reseller/admin tokens
  const ENV_CLIENT_ID  = process.env.CHM_CLIENT_ID  || "";
  const ENV_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "";
  const ENV_GROUP_ID   = process.env.CHM_GROUP_ID   || "";

  const missing = [!CHM_TOKEN && "CHATMETER_V5_TOKEN", !SELF_BASE && "SELF_BASE_URL"].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(", ")}`, version: VERSION });
  }

  // parse query overrides
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

  // base query for Chatmeter
  let baseQuery = `limit=50&sortField=reviewDate&sortOrder=DESC`;
  if (clientId)  baseQuery += `&clientId=${encodeURIComponent(clientId)}`;
  if (accountId) baseQuery += `&accountId=${encodeURIComponent(accountId)}`;
  if (groupId)   baseQuery += `&groupId=${encodeURIComponent(groupId)}`;

  // 1) updatedSince
  const url1 = `${CHM_BASE}/reviews?${baseQuery}&updatedSince=${encodeURIComponent(sinceIso)}`;
  const first = await fetchWithPeek(url1, CHM_TOKEN);

  // fallback: explicit start/end
  let items = first.items;
  let second = null;
  if (!items.length) {
    const url2 = `${CHM_BASE}/reviews?${baseQuery}&startDate=${encodeURIComponent(sinceIso)}&endDate=${encodeURIComponent(endIso)}`;
    second = await fetchWithPeek(url2, CHM_TOKEN);
    items = second.items;
  }

  // hydrate missing location names (batch simple: one-by-one with cache)
  const locMap = await hydrateLocationNames(items, CHM_BASE, CHM_TOKEN);

  // push to /api/review-webhook
  let posted = 0, skipped = 0, errors = 0;
  for (const it of items) {
    const id =
      it?.id ??
      it?.reviewId ??
      it?.review_id ??
      it?.reviewID ??
      it?.providerReviewId ?? null;
    if (!id) { skipped++; continue; }

    const locationId =
      it.locationId ??
      it.location_id ??
      it.providerLocationId ?? "";

    const locationName =
      it.locationName ??
      it.location_name ??
      it.location ??
      (locationId ? (locMap[`${locationId}`] || "") : "") ||
      "Unknown";

    const rating = it.rating ?? it.stars ?? it.score ?? 0;

    // author + links from ReviewBuilder shape
    const authorName =
      it.authorName ?? it.reviewerUserName ?? it.reviewerName ?? it.author ?? "Chatmeter Reviewer";

    const publicUrl =
      it.publicUrl ?? it.reviewURL ?? it.url ?? "";

    const createdAt =
      it.reviewDate ?? it.createdAt ?? it.date ?? it.createdOn ?? "";

    const text = extractText(it);

    const payload = {
      id,
      locationId,
      locationName,
      rating,
      authorName,
      createdAt,
      text,
      publicUrl,
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
    enrichment: { locations_resolved: Object.keys(locMap).length },
    debug: {
      first:  { url: first.url,  status: first.status,  ok: first.ok,  body_snippet: first.bodySnippet },
      second: second && { url: second.url, status: second.status, ok: second.ok, body_snippet: second.bodySnippet }
    }
  });
}

/* ---------------- helpers ---------------- */

async function fetchWithPeek(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: token } });
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
  if (Array.isArray(data.reviews)) return data.reviews; // ReviewBuilder
  if (Array.isArray(data.items))   return data.items;
  return [];
}

// try many likely fields + mine from reviewData[]
function extractText(it) {
  const candidates = [
    it.text, it.reviewText, it.content, it.comment, it.message,
    it.detail, it.body, it.responseText, it.consumerComment
  ];
  const cleaned = candidates
    .map(x => (x == null ? "" : String(x).trim()))
    .filter(Boolean);

  // ReviewBuilder often returns an array of { name, value } pairs
  const rd = it.reviewData || it.data || it.answers || it.fields;
  const fromRD = [];
  if (Array.isArray(rd)) {
    for (const row of rd) {
      const name = String(row?.name ?? row?.label ?? row?.question ?? "").toLowerCase();
      const val  = row?.value ?? row?.answer ?? row?.text ?? row?.comment ?? "";
      if (!val) continue;
      if (/(comment|feedback|text|review|message|free|open)/.test(name)) {
        fromRD.push(String(val).trim());
      }
    }
  }

  const result = [...cleaned, ...fromRD].filter(Boolean).join("\n").trim();
  return result;
}

// fetch missing location names using /locations/{id}
async function hydrateLocationNames(items, base, token) {
  const need = new Set();
  for (const it of items) {
    const hasName = Boolean(it.locationName || it.location_name || it.location);
    const id = it.locationId ?? it.location_id ?? it.providerLocationId;
    if (!hasName && id) need.add(String(id));
  }
  const locMap = Object.create(null);
  for (const id of need) {
    try {
      const r = await fetch(`${base}/locations/${encodeURIComponent(id)}`, {
        headers: { Authorization: token }
      });
      if (!r.ok) continue;
      const txt = await r.text();
      const d = safeParse(txt, {});
      const name = d?.name ?? d?.locationName ?? d?.title ?? "";
      if (name) locMap[id] = name;
    } catch {}
  }
  return locMap;
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

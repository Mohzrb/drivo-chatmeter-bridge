// Poll Chatmeter for recent reviews and forward to /api/review-webhook
export default async function handler(req, res) {
  // Require CRON_SECRET (Vercel Cron sends Authorization: Bearer <CRON_SECRET>)
  const want = process.env.CRON_SECRET || "";
  const got  = req.headers?.authorization || req.headers?.Authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-08" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;          // raw token (no "Bearer")
  const SELF_BASE = process.env.SELF_BASE_URL;               // e.g., https://drivo-chatmeter-bridge.vercel.app
  const LOC_MAP   = parseJSON(process.env.LOCATION_MAP_JSON || "{}", {}); // {"1001892551":"JFK",...}

  if (!CHM_TOKEN) return res.status(500).json({ ok: false, error: "Missing CHATMETER_V5_TOKEN" });
  if (!SELF_BASE) return res.status(500).json({ ok: false, error: "Missing SELF_BASE_URL" });

  try {
    const url = new URL(req.url, "http://localhost");
    const minutes   = toInt(url.searchParams.get("minutes"), 15);
    const dry       = url.searchParams.get("dry") === "1";
    const maxItems  = toInt(url.searchParams.get("max"), 50);
    const clientId  = strOrEmpty(url.searchParams.get("clientId") || process.env.CHM_CLIENT_ID);
    const accountId = strOrEmpty(url.searchParams.get("accountId") || process.env.CHM_ACCOUNT_ID);
    const groupId   = strOrEmpty(url.searchParams.get("groupId") || process.env.CHM_GROUP_ID);

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const params = new URLSearchParams();
    params.set("limit", String(Math.min(50, Math.max(1, maxItems))));
    params.set("sortField", "reviewDate");
    params.set("sortOrder", "DESC");
    params.set("updatedSince", sinceIso);
    if (clientId)  params.set("clientId",  clientId);
    if (accountId) params.set("accountId", accountId);
    if (groupId)   params.set("groupId",   groupId);

    const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;
    const first = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const firstTxt = await first.text();
    if (!first.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter list error: ${first.status} ${firstTxt}` });
    }

    // Chatmeter can return {reviews:[...]} or raw array
    const parsed = safeParse(firstTxt, {});
    const items = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed.reviews) ? parsed.reviews
                : Array.isArray(parsed.results) ? parsed.results
                : [];

    let posted = 0, skipped = 0, errors = 0;
    const toProcess = items.slice(0, maxItems);

    for (const it of toProcess) {
      const id = it?.id || it?.reviewId || it?.review_id || null;
      if (!id) { skipped++; continue; }

      const rating     = toInt(it?.rating, 0);
      const provider   = (it?.contentProvider || it?.provider || "").toString().toUpperCase();
      const reviewDate = it?.reviewDate || it?.createdAt || "";
      const author     = it?.reviewerUserName || it?.authorName || "Chatmeter Reviewer";
      const reviewURL  = it?.reviewURL || it?.publicUrl || "";
      const locationId = it?.locationId ? String(it.locationId) : "";
      const locationName = LOC_MAP[locationId] || it?.locationName || "Unknown";

      const text = pickText(it);

      const payload = {
        id: String(id),
        locationId,
        locationName,
        rating,
        authorName: author,
        createdAt: reviewDate,
        text,
        publicUrl: reviewURL,
        provider
      };

      if (dry) { posted++; continue; }

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
      version: "poller-v2-2025-10-08",
      echo: {
        rawUrl: req.url,
        minutes,
        clientId:  clientId || "",
        accountId: accountId || "",
        groupId:   groupId || "",
        dry,
        maxItems
      },
      since: sinceIso,
      checked: toProcess.length,
      posted, skipped, errors,
      debug: { url: listUrl, body_snippet: (firstTxt || "").slice(0, 240) }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// ---- helpers ----
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function parseJSON(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function strOrEmpty(v) { return v ? String(v) : ""; }

function pickText(it) {
  // 1) obvious fields
  const direct = it?.text || it?.reviewText || it?.content || "";
  if (direct) return String(direct);

  // 2) reviewData array from Chatmeter v5
  const rd = Array.isArray(it?.reviewData) ? it.reviewData : [];
  const get = (names) => {
    for (const name of names) {
      const f = rd.find(x => (x?.name || "").toLowerCase() === name);
      if (f?.value) return String(f.value);
    }
    return "";
  };

  // Try common keys used by Chatmeter / providers
  const text =
    get(["review_text", "reviewtext", "review_content", "content", "comment", "comments"]) ||
    get(["nps_comment", "np_comment", "np_content_1", "free_text", "freeText"]) ||
    "";

  return text;
}

// api/poll-v2.js
// Poll Chatmeter reviews and create Zendesk tickets (with robust text + nice location label)

export default async function handler(req, res) {
  // ---- security: Vercel Cron or manual call with CRON_SECRET
  const want = process.env.CRON_SECRET;
  const got  = req.headers.authorization || req.headers.Authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-07" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  if (!CHM_TOKEN) return res.status(500).json({ ok:false, error:"Missing CHATMETER_V5_TOKEN" });

  const SELF_BASE = process.env.SELF_BASE_URL || "";
  if (!SELF_BASE) return res.status(500).json({ ok:false, error:"Missing SELF_BASE_URL" });

  // Optional scoping
  const urlMinutes = Number((req.query.minutes ?? req.query.min ?? 60));
  const urlClientId  = (req.query.clientId  || "").trim();
  const urlAccountId = (req.query.accountId || process.env.CHM_ACCOUNT_ID || "").trim();
  const urlGroupId   = (req.query.groupId   || "").trim();
  const DRY = (req.query.dry || "") === "1";
  const MAX = Number(req.query.max || 50);   // <= batch size (just for safety tests)

  const sinceIso = new Date(Date.now() - urlMinutes * 60 * 1000).toISOString();

  // Location label map: {"1001892551":"JFK",...}
  const locMap = safeParseJSON(process.env.CHM_LOCATION_MAP, {});

  // Build listing URL
  const params = new URLSearchParams({
    limit: String(Math.min(MAX, 50)),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso,
  });
  if (urlClientId)  params.set("clientId",  urlClientId);
  if (urlAccountId) params.set("accountId", urlAccountId);
  if (urlGroupId)   params.set("groupId",   urlGroupId);

  const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;
  const listRes = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN }});
  const bodyText = await listRes.text();

  if (!listRes.ok) {
    return res.status(502).json({ ok:false, error:`Chatmeter list ${listRes.status}`, snippet: bodyText.slice(0,400) });
  }

  const list = safeParseJSON(bodyText, {});
  const items = Array.isArray(list.reviews) ? list.reviews : (Array.isArray(list) ? list : []);
  let posted=0, skipped=0, errors=0;

  for (const r of items) {
    const id = r?.id || r?.reviewId || r?.providerReviewId;
    if (!id) { skipped++; continue; }

    // Robust free-text extraction from list item…
    let text = pickText(r);

    // For Google/Yelp/Trustpilot/Facebook OR when no text, fetch detail and try again
    const provider = (r.contentProvider || r.provider || r.source || "").toUpperCase();
    const NEEDS_DETAIL = !text || ALWAYS_DETAIL_PROVIDERS.has(provider);
    let detail;
    if (NEEDS_DETAIL) {
      detail = await fetchDetail(CHM_BASE, CHM_TOKEN, id);
      if (detail) {
        const t2 = pickText(detail);
        if (t2) text = t2;
      }
    }

    // Location label
    const locId = String(r.locationId || detail?.locationId || "");
    const niceLocation = labelForLocation(locId, r.locationName || detail?.locationName, locMap);

    // Build payload for our ticket-creator
    const payload = {
      id,
      locationId: locId,
      locationName: niceLocation,        // << pretty label
      rating: Number(r.rating ?? detail?.rating ?? 0),
      authorName: r.reviewerUserName || r.authorName || detail?.reviewerUserName || "Reviewer",
      createdAt: r.reviewDate || r.createdAt || detail?.reviewDate || "",
      text: text || "",
      publicUrl: r.reviewURL || r.publicUrl || detail?.reviewURL || detail?.publicUrl || "",
      portalUrl: detail?.portalUrl || r.portalUrl || ""
    };

    try {
      if (!DRY) {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(await resp.text());
      }
      posted++;
    } catch {
      errors++;
    }
  }

  return res.status(200).json({
    ok: true,
    version: "poller-v2-googlefix-2025-10-07",
    echo: { rawUrl: req.url, minutes: urlMinutes, clientId: urlClientId, accountId: urlAccountId, groupId: urlGroupId, dry: DRY, maxItems: MAX },
    since: sinceIso, checked: items.length, posted, skipped, errors
  });
}

/* ---------- helpers ---------- */

const ALWAYS_DETAIL_PROVIDERS = new Set(["GOOGLE","YELP","TRUSTPILOT","FACEBOOK"]);

function safeParseJSON(s, fb){ try { return JSON.parse(s); } catch { return fb; } }

function labelForLocation(locId, hintName, map){
  if (!locId) return hintName || "";
  if (map && map[locId]) return map[locId];
  if (hintName) return hintName;
  return `Location ${locId}`;
}

// Pull text out of many possible shapes
function pickText(src) {
  if (!src || typeof src !== "object") return "";
  const direct = [
    src.text, src.reviewText, src.comment, src.content,
    src.body, src.reviewContent, src.description, src.reviewerComment
  ];
  for (const v of direct) if (isNonEmptyString(v)) return v.trim();

  const baskets = [];
  if (Array.isArray(src.reviewData)) baskets.push(src.reviewData);
  if (Array.isArray(src.data))       baskets.push(src.data);
  if (Array.isArray(src.details))    baskets.push(src.details);

  const wantedNames = new Set([
    "comment","review_text","text","body","content","review","comment_text","message","reviewercomment"
  ]);

  for (const arr of baskets) {
    for (const it of arr) {
      const name = String(it?.name || it?.key || "").toLowerCase();
      const val  = it?.value ?? it?.val ?? it?.text;
      if (wantedNames.has(name) && isNonEmptyString(val)) return String(val).trim();
    }
    // recursive safety for nested structures
    for (const it of arr) {
      const v = pickText(it);
      if (isNonEmptyString(v)) return v.trim();
    }
  }
  return "";
}

function isNonEmptyString(x){ return typeof x === "string" && x.trim().length > 0; }

async function fetchDetail(base, token, id){
  try {
    const r = await fetch(`${base}/reviews/${encodeURIComponent(id)}`, { headers: { Authorization: token }});
    const t = await r.text();
    if (!r.ok) return null;
    return safeParseJSON(t, null);
  } catch { return null; }
}

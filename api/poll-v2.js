// File: api/poll-v2.js
// Poll Chatmeter for recent reviews and forward them to /api/review-webhook
// Ultra-safe: no enrichment, supports dry-run and max cap, robust parsing.
// Query params:
//   minutes=<int>     (lookback; default env POLLER_LOOKBACK_MINUTES or 15)
//   accountId=<str>   (or CHM_ACCOUNT_ID env)
//   clientId=<str>    (or CHM_CLIENT_ID env)
//   groupId=<str>     (or CHM_GROUP_ID env)
//   dry=1             (test run, no tickets created)
//   max=<1..50>       (cap items processed; default 50)

export default async function handler(req, res) {
  const VERSION = "poller-v2-ultrasafe+surveytext-2025-10-07";
  try {
    // Optional auth (recommended for cron)
    const want = process.env.CRON_SECRET;
    const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
    if (want && got !== `Bearer ${want}`) {
      return res
        .status(401)
        .json({ ok: false, error: "Unauthorized", version: VERSION });
    }

    // Required env
    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;      // raw token (no "Bearer")
    const SELF_BASE = process.env.SELF_BASE_URL;           // e.g. https://<your-app>.vercel.app
    if (!CHM_TOKEN || !SELF_BASE) {
      return res.status(500).json({
        ok: false,
        error: "Missing env: CHATMETER_V5_TOKEN or SELF_BASE_URL",
        version: VERSION,
      });
    }

    // Parse query
    const baseForURL = `https://${req?.headers?.host || "x.local"}`;
    const u = new URL(req.url || "/api/poll-v2", baseForURL);

    const minutes = Number(
      u.searchParams.get("minutes") || process.env.POLLER_LOOKBACK_MINUTES || 15
    );
    const clientId  = u.searchParams.get("clientId")  || process.env.CHM_CLIENT_ID  || "";
    const accountId = u.searchParams.get("accountId") || process.env.CHM_ACCOUNT_ID || "";
    const groupId   = u.searchParams.get("groupId")   || process.env.CHM_GROUP_ID   || "";
    const dry       = ["1","true","yes","on"].includes((u.searchParams.get("dry") || "").toLowerCase());
    const maxItems  = Math.max(1, Math.min(50, Number(u.searchParams.get("max") || 50)));

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Build Chatmeter URL (updatedSince)
    let q = `limit=${maxItems}&sortField=reviewDate&sortOrder=DESC&updatedSince=${encodeURIComponent(sinceIso)}`;
    if (clientId)  q += `&clientId=${encodeURIComponent(clientId)}`;
    if (accountId) q += `&accountId=${encodeURIComponent(accountId)}`;
    if (groupId)   q += `&groupId=${encodeURIComponent(groupId)}`;

    const url = `${CHM_BASE}/reviews?${q}`;

    // Call Chatmeter
    const r = await fetch(url, { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `Chatmeter ${r.status}`,
        snippet: (txt || "").slice(0, 250),
        version: VERSION,
      });
    }

    const items = extractItems(txt);

    // Post to our webhook (unless dry)
    let posted = 0, skipped = 0, errors = 0;
    if (!dry) {
      for (const it of items.slice(0, maxItems)) {
        const payload = buildPayload(it);
        if (!payload.id) { skipped++; continue; }
        try {
          const rr = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!rr.ok) { errors++; continue; }
          posted++;
        } catch {
          errors++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      version: VERSION,
      echo: { rawUrl: req.url, minutes, clientId, accountId, groupId, dry, maxItems },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors,
      debug: { url, body_snippet: (txt || "").slice(0, 300) },
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      version: "poller-v2-ultrasafe+surveytext-2025-10-07",
      caught: String(e),
    });
  }
}

/* ---------- helpers ---------- */

function extractItems(txt) {
  try {
    const data = JSON.parse(txt);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.reviews)) return data.reviews; // ReviewBuilder
    if (Array.isArray(data.items))   return data.items;
    return [];
  } catch {
    return [];
  }
}

function buildPayload(it) {
  const id = it?.id ?? it?.reviewId ?? it?.review_id ?? it?.reviewID ?? it?.providerReviewId ?? null;
  const locationId   = it.locationId ?? it.location_id ?? it.providerLocationId ?? "";
  const locationName = it.locationName ?? it.location_name ?? it.location ?? "Unknown";
  const rating       = it.rating ?? it.stars ?? it.score ?? 0;
  const authorName   = it.authorName ?? it.reviewerUserName ?? it.reviewerName ?? it.author ?? "Chatmeter Reviewer";
  const publicUrl    = it.publicUrl ?? it.reviewURL ?? it.url ?? "";
  const createdAt    = it.reviewDate ?? it.createdAt ?? it.date ?? it.createdOn ?? "";
  const text         = extractText(it);

  return {
    id,
    locationId,
    locationName,
    rating,
    authorName,
    createdAt,
    text,
    publicUrl,
    portalUrl: it.portalUrl ?? it.portal_url ?? "",
  };
}

// Improved text extraction:
// - keeps common top-level fields
// - pulls free-text from survey/NPS arrays (reviewData/data/answers/fields/etc.)
// - filters out numbers/booleans/bare "false"/"true"/"n/a" strings, keeps real phrases
function extractText(it) {
  const isFreeText = (v) => {
    if (v == null) return false;
    const s = String(v).trim();
    if (!s) return false;
    const low = s.toLowerCase();
    if (["n/a","na","none","null","nil","-", "false","true"].includes(low)) return false;
    if (/^\d+(\.\d+)?$/.test(s)) return false; // pure number
    return s.length >= 3;
  };

  const out = [];

  // 1) common top-level text fields
  const fields = [
    it.text, it.reviewText, it.content, it.comment, it.message,
    it.detail, it.body, it.responseText, it.consumerComment
  ];
  for (const f of fields) if (isFreeText(f)) out.push(String(f).trim());

  // 2) survey-like arrays
  const candidates =
    it.reviewData || it.data || it.answers || it.fields ||
    it.surveyData || it.survey || it.response || [];

  const rows = Array.isArray(candidates) ? candidates : [];
  for (const row of rows) {
    const val = row?.value ?? row?.answer ?? row?.text ?? row?.comment ?? "";
    if (isFreeText(val)) out.push(String(val).trim());

    // nested answers inside a row
    const sub = row?.answers || row?.responses || row?.values;
    if (Array.isArray(sub)) {
      for (const a of sub) {
        const aval = a?.value ?? a?.answer ?? a?.text ?? a?.comment ?? "";
        if (isFreeText(aval)) out.push(String(aval).trim());
      }
    }
  }

  // unique + join
  return Array.from(new Set(out)).join("\n").trim();
}

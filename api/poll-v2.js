// api/poll-v2.js
export default async function handler(req, res) {
  // auth for cron
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || req.headers.Authorization || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return res
      .status(401)
      .json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-07" });
  }

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const SELF_BASE = process.env.SELF_BASE_URL;
  const ACCT_ENV  = process.env.CHM_ACCOUNT_ID || "";

  if (!CHM_TOKEN || !SELF_BASE) {
    return res.status(500).json({ ok: false, error: "Missing CHATMETER_V5_TOKEN or SELF_BASE_URL" });
  }

  // query params
  const u = new URL(req.url, "https://dummy");
  const minutes   = +(u.searchParams.get("minutes") || 20);
  const clientId  = (u.searchParams.get("clientId") || "").trim();
  const accountId = (u.searchParams.get("accountId") || ACCT_ENV).trim();
  const groupId   = (u.searchParams.get("groupId") || "").trim();
  const maxItems  = +(u.searchParams.get("max") || 50);
  const dryRun    = ["1", "true", "yes"].includes((u.searchParams.get("dry") || "").toLowerCase());

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // Build list URL
  const params = new URLSearchParams({
    limit: String(maxItems),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso
  });
  if (clientId)  params.set("clientId",  clientId);
  if (accountId) params.set("accountId", accountId);
  if (groupId)   params.set("groupId",   groupId);

  const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;

  try {
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter list ${r.status}`, body: txt });
    }

    const parsed = safeParse(txt, {});
    const items  = Array.isArray(parsed?.reviews) ? parsed.reviews
                  : Array.isArray(parsed) ? parsed
                  : [];

    let posted = 0, skipped = 0, errors = 0;

    for (const it of items.slice(0, maxItems)) {
      const id = it?.id || it?.reviewId || it?.review_id;
      if (!id) { skipped++; continue; }

      // Extract best-effort text; if empty, enrich with GET /reviews/{id}
      let commentText = extractText(it);
      if (!commentText) {
        try {
          const d = await fetch(`${CHM_BASE}/reviews/${encodeURIComponent(id)}`, {
            headers: { Authorization: CHM_TOKEN }
          });
          if (d.ok) {
            const full = safeParse(await d.text(), {});
            commentText = extractText(full?.review || full) || commentText;
          }
        } catch {}
      }

      const payload = {
        id,
        contentProvider: it.contentProvider || it.provider || "",
        locationId: it.locationId || "",
        locationName: it.locationName || "",
        rating: it.rating ?? 0,
        authorName: it.reviewerUserName || it.authorName || it.userName || "Chatmeter Reviewer",
        createdAt: it.reviewDate || it.createdAt || "",
        text: commentText || "",
        publicUrl: it.reviewURL || it.publicUrl || "",
        portalUrl: it.portalUrl || ""
      };

      if (dryRun) { continue; }

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
      version: "poller-v2-ultrasafe+surveytext-2025-10-07",
      echo: {
        rawUrl: u.pathname + u.search,
        minutes, clientId, accountId, groupId, dry: dryRun, maxItems
      },
      since: sinceIso,
      checked: Math.min(items.length, maxItems),
      posted, skipped, errors,
      debug: { url: listUrl, body_snippet: (txt || "").slice(0, 240) }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

function extractText(r) {
  const direct = [
    r?.text, r?.reviewText, r?.comment, r?.body, r?.content, r?.description, r?.message
  ].find(v => isNonEmpty(v));
  if (direct) return direct;

  const arr = Array.isArray(r?.reviewData) ? r.reviewData : [];
  for (const row of arr) {
    const key = String(row?.name || row?.field || row?.question || "").toLowerCase();
    const val = String(row?.value ?? row?.answer ?? row?.text ?? "").trim();
    if (!val) continue;
    if (key.match(/open|free|comment|word|text|describe|explain|feedback|overall/)) {
      if (val.length > 2 && !isNumeric(val)) return val;
    }
  }
  return "";
}

function isNonEmpty(x) { return typeof x === "string" && x.trim().length > 2; }
function isNumeric(x) { return /^[\d.]+$/.test(String(x || "")); }

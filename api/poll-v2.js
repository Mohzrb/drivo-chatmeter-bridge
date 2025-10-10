// /api/poll-v2.js
// Fetch recent Chatmeter reviews and forward to /api/review-webhook.
// Provider-specific comment extraction is handled in the webhook (with detail fetch).

import { normalizeProvider, safeJSON } from "./_helpers.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    // minimal auth (cron secret)
    const want = process.env.CRON_SECRET;
    const got = req.headers?.authorization || req.headers?.Authorization || "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-10" });
    }

    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    const SELF_BASE = process.env.SELF_BASE_URL;
    const DEF_ACCT  = process.env.CHM_ACCOUNT_ID || "";

    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");
    if (!SELF_BASE) return res.status(500).send("Missing env: SELF_BASE_URL");

    const q = req.query || {};
    const minutes   = clampInt(q.minutes, 60, 5, 43200);
    const maxItems  = clampInt(q.max, 50, 1, 200);
    const accountId = (q.accountId || DEF_ACCT || "").toString().trim();
    const clientId  = (q.clientId || "").toString().trim();
    const groupId   = (q.groupId || "").toString().trim();

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      limit: String(maxItems),
      sortField: "reviewDate",
      sortOrder: "DESC",
      updatedSince: sinceIso,
    });
    if (accountId) params.set("accountId", accountId);
    if (clientId)  params.set("clientId", clientId);
    if (groupId)   params.set("groupId", groupId);

    const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const raw = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter list error ${r.status}`, body_snippet: raw.slice(0, 400) });
    }

    const payload = safeJSON(raw, {});
    const list = Array.isArray(payload?.reviews) ? payload.reviews
              : Array.isArray(payload?.results) ? payload.results
              : Array.isArray(payload)           ? payload
              : [];

    let posted = 0, skipped = 0, errors = 0;
    for (const it of list) {
      const id =
        it?.id || it?.reviewId || it?.providerReviewId || null;
      if (!id) { skipped++; continue; }

      const provider = normalizeProvider(it?.contentProvider || it?.provider || "");
      const body = {
        id:           String(id),
        provider,
        locationId:   String(it?.locationId || ""),
        locationName: String(it?.locationName || ""),
        rating:       Number(it?.rating || 0),
        authorName:   it?.reviewerUserName || it?.authorName || it?.reviewer || "Reviewer",
        createdAt:    it?.reviewDate || it?.createdAt || "",
        text:         (typeof it?.text === "string") ? it.text : (typeof it?.comment === "string") ? it.comment : "", // may be empty/boolean; webhook will re-fetch
        publicUrl:    it?.reviewURL || it?.publicUrl || it?.portalUrl || "",
      };

      try {
        const r2 = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r2.ok) posted++; else errors++;
      } catch { errors++; }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-10",
      echo: { minutes, accountId, clientId, groupId, maxItems },
      since: sinceIso,
      checked: list.length, posted, skipped, errors
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

/* --------------- utils --------------- */
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  return def;
}

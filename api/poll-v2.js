// /api/poll-v2.js
// Pull from Chatmeter v5 and forward normalized items to /api/review-webhook

import { getProviderComment } from "./_helpers.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const CHM_BASE   = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN  = process.env.CHATMETER_V5_TOKEN;           // raw token (no "Bearer")
  const SELF_BASE  = process.env.SELF_BASE_URL;                 // your Vercel base URL
  const CRON_SECRET = process.env.CRON_SECRET;                  // protect the poller

  // simple auth
  const got = req.headers?.authorization || req.headers?.Authorization;
  if (CRON_SECRET && got !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-08" });
  }

  const minutes  = Number(req.query.minutes || 1440);  // default 24h
  const maxItems = Number(req.query.max || 50);
  const dryRun   = String(req.query.dry || "").toLowerCase() === "1";
  const accountId = req.query.accountId || process.env.CHM_ACCOUNT_ID || "";
  const groupId   = req.query.groupId   || "";

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !SELF_BASE && "SELF_BASE_URL",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    limit: String(maxItems),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso
  });
  if (accountId) query.set("accountId", accountId);
  if (groupId)   query.set("groupId", groupId);

  try {
    const r = await fetch(`${CHM_BASE}/reviews?${query.toString()}`, {
      headers: { Authorization: CHM_TOKEN }
    });
    const rawText = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter list error: ${r.status} ${rawText}`);

    const payload = JSON.parse(rawText);
    const list = Array.isArray(payload?.reviews) ? payload.reviews
              : Array.isArray(payload)           ? payload
              : Array.isArray(payload?.results)  ? payload.results
              : [];

    let posted = 0, skipped = 0;

    for (const it of list) {
      const provider = (it.contentProvider || it.provider || "").toUpperCase();
      const norm = {
        id: it.id || it.reviewId || it.providerReviewId,
        provider,
        locationId: it.locationId || "",
        locationName: it.locationName || "",
        rating: Number(it.rating || it.stars || 0),
        authorName: it.reviewerUserName || it.reviewer || it.author || "",
        authorEmail: it.reviewerEmail || "",
        createdAt: it.reviewDate || it.createdAt || new Date().toISOString(),
        text: getProviderComment(provider, it),
        publicUrl: it.reviewURL || it.publicUrl || it.portalUrl || ""
      };
      if (!norm.id) { skipped++; continue; }

      if (dryRun) { posted++; continue; } // simulate

      const r2 = await fetch(`${SELF_BASE}/api/review-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(norm)
      });
      if (r2.ok) posted++; else skipped++;
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-08",
      echo: {
        minutes, clientId: "", accountId, groupId, dry: dryRun, maxItems
      },
      since: sinceIso,
      checked: list.length,
      posted, skipped, errors: 0
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

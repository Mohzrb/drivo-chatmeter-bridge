// /api/poll-v2.js
// Pulls from Chatmeter and forwards normalized items to /api/review-webhook.

import { getProviderComment, normalizeProvider } from "./_helpers.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const CHM_BASE   = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN  = process.env.CHATMETER_V5_TOKEN;
  const SELF_BASE  = process.env.SELF_BASE_URL;
  const CRON_SECRET= process.env.CRON_SECRET;

  // simple auth
  const got = req.headers?.authorization || req.headers?.Authorization;
  if (CRON_SECRET && got !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-10" });
  }

  const minutes   = clampInt(req.query.minutes, 60, 5, 43200);
  const maxItems  = clampInt(req.query.max, 50, 1, 200);
  const dryRun    = String(req.query.dry || "").toLowerCase() === "1";
  const accountId = req.query.accountId || process.env.CHM_ACCOUNT_ID || "";
  const groupId   = req.query.groupId   || "";

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !SELF_BASE && "SELF_BASE_URL",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const q = new URLSearchParams({
    limit: String(maxItems),
    sortField: "reviewDate",
    sortOrder: "DESC",
    updatedSince: sinceIso,
  });
  if (accountId) q.set("accountId", accountId);
  if (groupId)   q.set("groupId", groupId);

  try {
    const r = await fetch(`${CHM_BASE}/reviews?${q.toString()}`, {
      headers: { Authorization: CHM_TOKEN },
    });
    const raw = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter list error: ${r.status} ${raw}`);

    const payload = safeParse(raw, {});
    const list = Array.isArray(payload?.reviews) ? payload.reviews
              : Array.isArray(payload)           ? payload
              : Array.isArray(payload?.results)  ? payload.results
              : [];

    let posted = 0, skipped = 0, errors = 0;

    for (const it of list) {
      const provider = normalizeProvider(it.contentProvider || it.provider || "");
      const norm = {
        id: it.id || it.reviewId || it.providerReviewId,
        provider,
        locationId: it.locationId || "",
        locationName: it.locationName || "",
        rating: Number(it.rating || it.stars || 0),
        authorName: it.reviewerUserName || it.reviewer || it.author || "",
        authorEmail: it.reviewerEmail || "",
        createdAt: it.reviewDate || it.createdAt || new Date().toISOString(),
        text: getProviderComment(provider, it), // first try on list response
        publicUrl: it.reviewURL || it.publicUrl || it.portalUrl || "",
      };
      if (!norm.id) { skipped++; continue; }

      try {
        if (!dryRun) {
          const r2 = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(norm),
          });
          if (!r2.ok) { errors++; continue; }
        }
        posted++;
      } catch { errors++; }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-10",
      echo: { minutes, accountId, groupId, dry: dryRun, maxItems: maxItems },
      since: sinceIso,
      checked: list.length,
      posted, skipped, errors,
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* -------------------- utils -------------------- */
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  return def;
}

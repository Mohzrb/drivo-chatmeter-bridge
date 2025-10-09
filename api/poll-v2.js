// /api/poll-v2.js
// Pull recent Chatmeter reviews and forward normalized payloads to /api/review-webhook

import { getProviderComment, normalizeProvider, pickCustomerContact } from "./_helpers.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

    // Protect the poller for GitHub/Vercel cron
    const need = process.env.CRON_SECRET;
    const got = req.headers.authorization || req.headers.Authorization || "";
    if (need && got !== `Bearer ${need}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-10" });
    }

    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    const SELF_BASE = process.env.SELF_BASE_URL;
    const DEF_ACCT  = process.env.CHM_ACCOUNT_ID || "";
    const LOC_MAP   = safeJson(process.env.CHM_LOCATION_MAP || "{}", {});

    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");
    if (!SELF_BASE) return res.status(500).send("Missing env: SELF_BASE_URL");

    const q = req.query || {};
    const minutes   = clamp(q.minutes, 60, 5, 43200);
    const max       = clamp(q.max, 50, 1, 200);
    const dry       = truthy(q.dry);
    const accountId = String(q.accountId || DEF_ACCT || "");
    const groupId   = String(q.groupId || "");
    const sinceIso  = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      limit: String(max),
      sortField: "reviewDate",
      sortOrder: "DESC",
      updatedSince: sinceIso
    });
    if (accountId) params.set("accountId", accountId);
    if (groupId)   params.set("groupId", groupId);

    const listUrl = `${CHM_BASE}/reviews?${params.toString()}`;
    const r = await fetch(listUrl, { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter list ${r.status}`, body_snippet: txt.slice(0, 400) });
    }
    const payload = safeJson(txt, {});
    const items = Array.isArray(payload?.reviews) ? payload.reviews
               : Array.isArray(payload?.results) ? payload.results
               : Array.isArray(payload) ? payload
               : [];

    let posted = 0, skipped = 0, errors = 0;

    for (const it of items) {
      const id = it?.id || it?.reviewId || it?.providerReviewId || null;
      if (!id) { skipped++; continue; }

      const provider = normalizeProvider(it?.contentProvider || it?.provider || "");
      const contact  = pickCustomerContact(it);
      const text     = getProviderComment(provider, it);  // will ignore true/false/rating-only
      const link     = it?.reviewURL || it?.publicUrl || it?.portalUrl || "";
      const locName  = it?.locationName || LOC_MAP[String(it?.locationId)] || "";

      const norm = {
        id: String(id),
        provider,
        locationId: String(it?.locationId || ""),
        locationName: String(locName || ""),
        rating: Number(it?.rating || it?.stars || 0),
        authorName: it?.reviewerUserName || it?.reviewer || it?.authorName || "",
        authorEmail: contact.email,
        authorPhone: contact.phone,
        createdAt: it?.reviewDate || it?.createdAt || "",
        text: text || "",
        publicUrl: link || ""
      };

      try {
        if (!dry) {
          const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(norm)
          });
          if (!resp.ok) { errors++; continue; }
        }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-10",
      echo: { minutes, accountId, groupId, dry, maxItems: max },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

/* utils */
const safeJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const clamp = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};
const truthy = (v) => ["1","true","yes","y","on"].includes(String(v || "").toLowerCase());

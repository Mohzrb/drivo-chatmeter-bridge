// api/poll-v2.js
// Poll Chatmeter for last ?minutes=N and POST each review to /api/review-webhook (authorized)

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    // optional auth for calling the poller
    const okBearer = process.env.AUTH_SECRET ? `Bearer ${process.env.AUTH_SECRET}` : null;
    const auth = req.headers.authorization || "";
    if (okBearer && auth !== okBearer) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // time window
    const minutes = clampInt(req.query.minutes ?? 1440, 1, 7 * 24 * 60);
    const max = clampInt(req.query.max ?? 100, 1, 500);
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // env (supports both CHATMETER_* and legacy CM_*)
    const CM_BASE = process.env.CHATMETER_BASE || process.env.CM_BASE || "https://live.chatmeter.com/v5";
    const CM_TOKEN = process.env.CHATMETER_TOKEN || process.env.CM_TOKEN || "";
    const CM_API_KEY = process.env.CHATMETER_API_KEY || ""; // some tenants use x-api-key
    const CM_ACCOUNT = process.env.CHATMETER_ACCOUNT_ID || "";

    const Z_BASE = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
    const WEBHOOK = "/api/review-webhook";
    const WH_SECRET = process.env.WEBHOOK_SECRET || "";

    if (!CM_TOKEN && !CM_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing CHATMETER_TOKEN or CHATMETER_API_KEY" });
    }

    const cmHeaders = () => {
      const h = { Accept: "application/json" };
      if (CM_TOKEN) h["Authorization"] = `Bearer ${CM_TOKEN}`;
      if (CM_API_KEY) h["x-api-key"] = CM_API_KEY;
      if (CM_ACCOUNT) h["x-account-id"] = CM_ACCOUNT;
      return h;
    };

    const getJson = async (url) => {
      const r = await fetch(url, { headers: cmHeaders() });
      if (!r.ok) return { ok: false, status: r.status, body: await r.text() };
      return { ok: true, status: r.status, json: await r.json() };
    };

    // quick probes (helpful if auth fails)
    for (const path of ["/me", "/status"]) {
      const probe = await getJson(`${CM_BASE}${path}`);
      if (!probe.ok) {
        return res.status(502).json({
          ok: false, error: `Chatmeter ${probe.status} on ${path}`,
          hint: hintFor401({ hasBearer: !!CM_TOKEN, hasKey: !!CM_API_KEY, hasAccount: !!CM_ACCOUNT })
        });
      }
    }

    // list reviews (common: /reviews?since=ISO&limit=N[&accountId=...])
    const listUrl = `${CM_BASE}/reviews?since=${encodeURIComponent(since)}&limit=${max}${CM_ACCOUNT ? `&accountId=${encodeURIComponent(CM_ACCOUNT)}` : ""}`;
    const listed = await getJson(listUrl);
    if (!listed.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter list error ${listed.status}`, body: listed.body?.slice(0, 800) });
    }

    // tolerate shapes: {data:[...]}, {reviews:[...]}, [...]
    const arr = Array.isArray(listed.json?.data) ? listed.json.data
              : Array.isArray(listed.json?.reviews) ? listed.json.reviews
              : (Array.isArray(listed.json) ? listed.json : []);
    if (!Array.isArray(arr)) {
      return res.status(200).json({ ok: true, since, checked: 0, posted: 0, skipped: 0, errors: 0, note: "No array in response" });
    }

    let posted = 0, skipped = 0, errors = 0;
    for (const r of arr) {
      const payload = normalizeReview(r);
      if (!payload?.id) { skipped++; continue; }

      const resp = await fetch(`${Z_BASE}${WEBHOOK}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(WH_SECRET ? { Authorization: `Bearer ${WH_SECRET}` } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) { errors++; continue; }
      const j = await resp.json().catch(() => null);
      if (j?.ok) posted++; else errors++;
      await sleep(150); // gentle pacing
    }

    return res.status(200).json({ ok: true, since, checked: arr.length, posted, skipped, errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// map Chatmeter review → intake payload
function normalizeReview(r) {
  return {
    platform: r.platform || r.provider || r.source || "unknown",
    id: r.id || r.reviewId || r.providerReviewId,
    rating: r.rating ?? r.stars ?? null,
    author: { name: r.authorName || r.author || r.reviewer || "Unknown Reviewer" },
    content: r.text || r.comment || r.content || "",
    url: r.publicUrl || r.url || r.link || "",
    location: { name: r.locationName || (r.location && r.location.name) || "" },
    createdAt: r.createdAt || r.reviewDate || r.created || new Date().toISOString(),
    nps: r.nps ? { score: r.nps.score, category: r.nps.category } : undefined,
    customer: r.customer ? { email: r.customer.email, name: r.customer.name } : undefined
  };
}

function clampInt(v, min, max){ const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min; }
function hintFor401({ hasBearer, hasKey, hasAccount }) {
  const tips = [];
  tips.push("Double-check Chatmeter credentials:");
  if (!hasBearer && !hasKey) tips.push("- Provide CHATMETER_TOKEN (Bearer) or CHATMETER_API_KEY (x-api-key).");
  tips.push("- Confirm CHATMETER_BASE for your tenant (often https://live.chatmeter.com/v5).");
  if (hasAccount) tips.push("- accountId/x-account-id is being sent.");
  tips.push("- Token/key must allow /me, /status, /reviews.");
  return tips.join(" ");
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

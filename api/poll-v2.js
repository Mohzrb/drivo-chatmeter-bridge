// /api/poll-v2.js
// Pull reviews since ?minutes=N and POST each to /api/review-webhook
// Robust diagnostics for Chatmeter 401/403

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    // --- auth to call this poller (your existing middleware may already do this)
    const auth = req.headers.authorization || "";
    const okBearer = `Bearer ${process.env.AUTH_SECRET}`;
    if (okBearer && auth !== okBearer) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // --- time window
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Number(req.query.minutes || 1440)));
    const max = Math.max(1, Math.min(500, Number(req.query.max || 100)));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // --- env
    const CM_BASE = process.env.CHATMETER_BASE || "https://live.chatmeter.com/v5";
    const CM_API_KEY = process.env.CHATMETER_API_KEY || "";
    const CM_BEARER = process.env.CHATMETER_TOKEN || "";
    const CM_ACCOUNT = process.env.CHATMETER_ACCOUNT_ID || ""; // optional per tenant

    const Z_BASE = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : ""; // optional if same host
    const WEBHOOK = "/api/review-webhook";

    if (!CM_API_KEY && !CM_BEARER) {
      return res.status(500).json({ ok: false, error: "Missing CHATMETER_API_KEY or CHATMETER_TOKEN" });
    }

    // --- headers builder
    const cmHeaders = () => {
      const h = { Accept: "application/json" };
      if (CM_API_KEY) h["x-api-key"] = CM_API_KEY;
      if (CM_BEARER) h["Authorization"] = `Bearer ${CM_BEARER}`;
      if (CM_ACCOUNT) h["x-account-id"] = CM_ACCOUNT; // some tenants need this
      return h;
    };

    // --- tiny helper for fetch with good error messages
    const getJson = async (url) => {
      const r = await fetch(url, { headers: cmHeaders() });
      if (!r.ok) {
        const body = await r.text();
        return { ok: false, status: r.status, url, body_snippet: body.slice(0, 800) };
      }
      return { ok: true, json: await r.json(), status: r.status, url };
    };

    // --- probes (very helpful to diagnose 401)
    const probePaths = [
      "/me",
      "/status",
      `/locations?limit=1&offset=0${CM_ACCOUNT ? `&accountId=${encodeURIComponent(CM_ACCOUNT)}` : ""}`,
      `/reviews?limit=1&offset=0${CM_ACCOUNT ? `&accountId=${encodeURIComponent(CM_ACCOUNT)}` : ""}`,
    ];
    for (const p of probePaths) {
      const probe = await getJson(`${CM_BASE}${p}`);
      if (!probe.ok) {
        return res.status(502).json({
          ok: false,
          error: `Chatmeter ${probe.status} on ${p}`,
          body_snippet: probe.body_snippet || "",
          hint: hintFor401({ hasKey: !!CM_API_KEY, hasBearer: !!CM_BEARER, hasAccount: !!CM_ACCOUNT }),
        });
      }
    }

    // --- main list (adjust to your API; many tenants use /reviews with since)
    const listUrl = `${CM_BASE}/reviews?since=${encodeURIComponent(since)}&limit=${max}${
      CM_ACCOUNT ? `&accountId=${encodeURIComponent(CM_ACCOUNT)}` : ""
    }`;
    const listed = await getJson(listUrl);
    if (!listed.ok) {
      return res.status(502).json({
        ok: false,
        error: `Chatmeter list error ${listed.status}`,
        body_snippet: listed.body_snippet || "",
        url: listed.url,
      });
    }

    const items = Array.isArray(listed.json?.data) ? listed.json.data : (listed.json?.reviews || []);
    if (!Array.isArray(items)) {
      return res.status(200).json({ ok: true, checked: 0, posted: 0, skipped: 0, errors: 0, note: "No array in response" });
    }

    // --- post each review to the webhook
    let posted = 0, skipped = 0, errors = 0;
    for (const r of items) {
      const payload = normalizeReview(r);
      if (!payload?.id) { skipped++; continue; }

      const resp = await fetch(`${Z_BASE || ""}${WEBHOOK}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        errors++;
      } else {
        const j = await resp.json().catch(() => ({}));
        if (j?.ok) posted++; else errors++;
      }
    }

    return res.status(200).json({ ok: true, since, checked: items.length, posted, skipped, errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// --- simple mapper; adapt fields if your tenant differs
function normalizeReview(r) {
  return {
    id: r.id || r.reviewId || r.providerReviewId,
    provider: r.provider || r.platform || r.source || "",
    locationId: r.locationId || r.location?.id || "",
    locationName: r.locationName || r.location?.name || "",
    rating: r.rating || r.stars || 0,
    createdAt: r.createdAt || r.reviewDate || r.created || new Date().toISOString(),
    authorName: r.authorName || r.author || r.reviewer || "",
    publicUrl: r.publicUrl || r.url || r.link || "",
    text: r.text || r.comment || r.content || "",
  };
}

function hintFor401({ hasKey, hasBearer, hasAccount }) {
  const lines = [];
  lines.push("Double-check Chatmeter credentials and tenant requirements:");
  if (!hasKey && !hasBearer) lines.push("- Set CHATMETER_API_KEY (x-api-key) or CHATMETER_TOKEN (Bearer).");
  if (hasKey && hasBearer) lines.push("- Using both is OK; either one will be sent.");
  lines.push("- Ensure CHATMETER_BASE is correct for your tenant (often https://live.chatmeter.com/v5).");
  lines.push("- Some tenants require x-account-id or accountId=... → set CHATMETER_ACCOUNT_ID.");
  lines.push("- If using Bearer, confirm the token isn’t expired and has scopes for /me, /reviews.");
  return lines.join("\n");
}

// Poller v2 — stage 2: Chatmeter fetch only (no imports, no Zendesk writes)
export default async function handler(req, res) {
  try {
    // Only GET
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    // Auth: Authorization: Bearer <CRON_SECRET>
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cron = process.env.CRON_SECRET || "";

    const presence = {
      CHATMETER_V5_BASE: !!process.env.CHATMETER_V5_BASE,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      CHATMETER_TOKEN: !!process.env.CHATMETER_TOKEN,
      CHATMETER_API_KEY: !!process.env.CHATMETER_API_KEY,
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN,
      CRON_SECRET: !!cron
    };

    if (!cron || bearer !== cron) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized", presence }));
    }

    // Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Chatmeter token + base
    const base = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const token =
      process.env.CHATMETER_V5_TOKEN ||
      process.env.CHATMETER_TOKEN ||
      process.env.CHATMETER_API_KEY ||
      "";

    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "env",
        presence,
        error: "Missing Chatmeter token"
      }));
    }

    // Fetch from Chatmeter
    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    let status = null, text = null, data = null;

    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store"
      });
      status = r.status;
      text = await r.text().catch(() => "");
      try { data = JSON.parse(text); } catch { data = null; }
    } catch (err) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "chatmeter-fetch", presence, error: String(err?.message || err)
      }));
    }

    if (status < 200 || status >= 300) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "chatmeter-http",
        presence,
        status,
        url,
        bodyPreview: (text || "").slice(0, 2000)
      }));
    }

    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

    // DRY mode only (no Zendesk writes yet)
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      stage: "chatmeter-ok",
      sinceIso,
      checked: arr.length,
      sampleKeys: arr[0] ? Object.keys(arr[0]) : null
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, stage: "top-catch", error: String(e?.message || e) }));
  }
}

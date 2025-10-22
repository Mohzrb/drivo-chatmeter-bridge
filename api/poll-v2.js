// Poller v2 — Chatmeter multi-auth probe (no Zendesk writes)
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

    if (!cron || bearer !== cron) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    // Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Chatmeter env
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
        error: "Missing Chatmeter token"
      }));
    }

    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;

    // Try several header styles commonly used by APIs
    const attempts = [
      { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      { name: "Authorization: Token",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } },
      { name: "X-Auth-Token",          headers: { "X-Auth-Token": token,            Accept: "application/json" } }
    ];

    const results = [];
    for (const attempt of attempts) {
      let status = null, text = null, json = null, ok = false;
      try {
        const r = await fetch(url, { headers: attempt.headers, cache: "no-store" });
        status = r.status;
        text = await r.text().catch(() => "");
        try { json = JSON.parse(text); } catch { json = null; }
        ok = r.ok;
      } catch (err) {
        results.push({ attempt: attempt.name, fetchError: String(err?.message || err) });
        continue;
      }
      results.push({
        attempt: attempt.name,
        status,
        ok,
        // show first 600 chars in case there's an error body
        bodyPreview: (text || "").slice(0, 600),
        sampleKeys: Array.isArray(json?.data) && json.data[0] ? Object.keys(json.data[0]) : null
      });
      if (ok) break; // stop on first success
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: results.some(r => r.ok),
      stage: "chatmeter-multi-auth",
      sinceIso,
      url,
      results
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, stage: "top-catch", error: String(e?.message || e) }));
  }
}

// Probes Chatmeter auth styles & endpoints to discover the right header combination.
// No Zendesk writes; safe to run.
export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cron = process.env.CRON_SECRET || "";
    if (!cron || bearer !== cron) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const base = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const token =
      process.env.CHATMETER_V5_TOKEN ||
      process.env.CHATMETER_TOKEN ||
      process.env.CHATMETER_API_KEY ||
      "";

    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Missing token env" }));
    }

    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const endpoints = [
      { name: "me",      url: `${base}/me` },
      { name: "reviews", url: `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=1` }
    ];

    const headerAttempts = [
      { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      { name: "Authorization: Token",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } },
      { name: "Authorization: token=…", headers: { Authorization: `Token token=${token}`, Accept: "application/json" } },
      { name: "X-Auth-Token",          headers: { "X-Auth-Token": token,            Accept: "application/json" } },
      { name: "X-API-Key",             headers: { "X-API-Key": token,               Accept: "application/json" } },
      { name: "X-Authorization",       headers: { "X-Authorization": token,         Accept: "application/json" } }
    ];

    const results = [];

    for (const ep of endpoints) {
      for (const attempt of headerAttempts) {
        let status = null, text = null, ok = false;
        try {
          const r = await fetch(ep.url, { headers: attempt.headers, cache: "no-store" });
          status = r.status;
          text = await r.text().catch(() => "");
          ok = r.ok;
        } catch (err) {
          results.push({ endpoint: ep.name, attempt: attempt.name, fetchError: String(err?.message || err) });
          continue;
        }
        results.push({
          endpoint: ep.name,
          attempt: attempt.name,
          status,
          ok,
          preview: (text || "").slice(0, 600)
        });
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: results.some(r => r.ok),
      base,
      results
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

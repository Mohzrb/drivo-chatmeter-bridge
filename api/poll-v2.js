// Poller v2 — Login-first then fetch reviews (no Zendesk writes yet)
export default async function handler(req, res) {
  try {
    // Allow only GET
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    // Security: Authorization: Bearer <CRON_SECRET>
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

    // Chatmeter base + creds
    const base = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const user = process.env.CHATMETER_USERNAME || "";
    const pass = process.env.CHATMETER_PASSWORD || "";
    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "env",
        error: "Missing CHATMETER_USERNAME or CHATMETER_PASSWORD"
      }));
    }

    // 1) LOGIN to Chatmeter to obtain a fresh token
    let loginStatus = null, loginJson = null, token = null;
    try {
      const lr = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
        cache: "no-store"
      });
      loginStatus = lr.status;
      const text = await lr.text();
      try { loginJson = JSON.parse(text); } catch { loginJson = { raw: text?.slice(0, 600) }; }
      token = loginJson?.token || loginJson?.access_token || null;
    } catch (e) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, stage: "login-fetch", error: String(e?.message || e) }));
    }
    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, stage: "login", status: loginStatus, body: loginJson }));
    }

    // 2) Try reviews with the freshly issued token (try a couple of header styles)
    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    const attempts = [
      { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      { name: "Authorization: Token",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } },
      { name: "Cookie: token=",        headers: { Cookie: `token=${token}`,        Accept: "application/json" } },
      { name: "X-Auth-Token",          headers: { "X-Auth-Token": token,           Accept: "application/json" } }
    ];

    let chosen = null, data = null, rawText = null, status = null;
    for (const attempt of attempts) {
      const r = await fetch(url, { headers: attempt.headers, cache: "no-store" });
      status = r.status;
      rawText = await r.text().catch(() => "");
      if (r.ok) {
        try { data = JSON.parse(rawText); } catch { data = null; }
        chosen = attempt.name;
        break;
      }
    }

    if (!chosen) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "reviews-auth",
        tried: attempts.map(a => a.name),
        lastStatus: status,
        bodyPreview: (rawText || "").slice(0, 1000)
      }));
    }

    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      stage: "chatmeter-ok",
      headerUsed: chosen,
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

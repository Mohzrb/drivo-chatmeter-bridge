// Poller v2 — login-first, then try multiple headers for /reviews
function envAny(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    // Auth: Authorization: Bearer <CRON_SECRET>
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cron = envAny("CRON_SECRET");
    if (!cron || bearer !== cron) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const base = envAny("CHATMETER_V5_BASE") || "https://live.chatmeter.com/v5";
    // Accept mixed-case env names (seen in your Vercel)
    const user = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
    const pass = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");

    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "env",
        error: "Missing CHATMETER_USERNAME or CHATMETER_PASSWORD",
        presence: {
          CHATMETER_USERNAME_upper: !!process.env.CHATMETER_USERNAME,
          CHATMETER_USERNAME_mixed: !!process.env.Chatmeter_username,
          CHATMETER_PASSWORD_upper: !!process.env.CHATMETER_PASSWORD,
          CHATMETER_PASSWORD_mixed: !!process.env.Chatmeter_password
        }
      }));
    }

    // 1) LOGIN
    let loginStatus = null, loginJson = null, token = null;
    try {
      const lr = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
        cache: "no-store"
      });
      loginStatus = lr.status;
      const t = await lr.text();
      try { loginJson = JSON.parse(t); } catch { loginJson = { raw: t?.slice(0, 600) }; }
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

    // 2) /reviews with multiple header styles
    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    const attempts = [
      { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      { name: "Authorization: Token",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } },
      { name: "Authorization: Token token=", headers: { Authorization: `Token token=${token}`, Accept: "application/json" } },
      { name: "Cookie: token=",        headers: { Cookie: `token=${token}`,        Accept: "application/json" } },
      { name: "X-Auth-Token",          headers: { "X-Auth-Token": token,           Accept: "application/json" } },
      { name: "X-API-Key",             headers: { "X-API-Key": token,              Accept: "application/json" } }
    ];

    const results = [];
    let chosen = null, data = null;

    for (const attempt of attempts) {
      let status = null, text = null, ok = false, sampleKeys = null;
      try {
        const r = await fetch(url, { headers: attempt.headers, cache: "no-store" });
        status = r.status;
        text = await r.text().catch(() => "");
        ok = r.ok;
        if (ok) {
          try {
            const js = JSON.parse(text);
            const arr = Array.isArray(js?.data) ? js.data : Array.isArray(js) ? js : [];
            sampleKeys = arr[0] ? Object.keys(arr[0]) : null;
            data = arr;
          } catch {
            ok = false; // treat as fail if body isn't valid JSON
          }
        }
      } catch (err) {
        results.push({ attempt: attempt.name, fetchError: String(err?.message || err) });
        continue;
      }
      results.push({
        attempt: attempt.name,
        status,
        ok,
        preview: (text || "").slice(0, 600),
        sampleKeys
      });
      if (ok) { chosen = attempt.name; break; }
    }

    if (!chosen) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "reviews-auth", url, results
      }));
    }

    // success — Chatmeter reachable with header 'chosen'
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      stage: "chatmeter-ok",
      headerUsed: chosen,
      sinceIso,
      checked: data.length,
      sampleKeys: data[0] ? Object.keys(data[0]) : null
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, stage: "top-catch", error: String(e?.message || e) }));
  }
}

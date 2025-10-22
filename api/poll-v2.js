// Poller v2 — login-first, robust env lookup, returns presence when creds missing
function envAny(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
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

    // Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // --- Robust env lookups (try common casing mistakes as well) ---
    const base = envAny("CHATMETER_V5_BASE") || "https://live.chatmeter.com/v5";
    const user = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
    const pass = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");

    const presence = {
      CHATMETER_V5_BASE: !!envAny("CHATMETER_V5_BASE"),
      CHATMETER_V5_TOKEN: !!envAny("CHATMETER_V5_TOKEN", "CHATMETER_TOKEN", "CHATMETER_API_KEY"),
      CHATMETER_USERNAME_upper: !!process.env.CHATMETER_USERNAME,
      CHATMETER_USERNAME_mixed: !!process.env.Chatmeter_username,
      CHATMETER_USERNAME_lower: !!process.env.chatmeter_username,
      CHATMETER_PASSWORD_upper: !!process.env.CHATMETER_PASSWORD,
      CHATMETER_PASSWORD_mixed: !!process.env.Chatmeter_password,
      CHATMETER_PASSWORD_lower: !!process.env.chatmeter_password
    };

    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "env",
        error: "Missing CHATMETER_USERNAME or CHATMETER_PASSWORD",
        presence
      }));
    }

    // 1) Login to Chatmeter
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
      return res.end(JSON.stringify({ ok: false, stage: "login-fetch", error: String(e?.message || e), presence }));
    }

    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, stage: "login", status: loginStatus, body: loginJson, presence }));
    }

    // 2) Fetch reviews using the new token
    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store"
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "reviews", status: r.status, bodyPreview: text.slice(0, 1000), presence
      }));
    }

    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true, stage: "chatmeter-ok", sinceIso, checked: arr.length,
      sampleKeys: arr[0] ? Object.keys(arr[0]) : null
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, stage: "top-catch", error: String(e?.message || e) }));
  }
}

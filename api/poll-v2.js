// Poller v2 — login, capture Set-Cookie, then call /reviews with cookie (and variations)
function envAny(...names) { for (const n of names) if (process.env[n]) return process.env[n]; return ""; }

export default async function handler(req, res) {
  try {
    // 1) Method + CRON_SECRET auth
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cron = envAny("CRON_SECRET");
    if (!cron || bearer !== cron) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    // 2) Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // 3) Env (accept mixed-case var names you used)
    const base = envAny("CHATMETER_V5_BASE") || "https://live.chatmeter.com/v5";
    const user = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
    const pass = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");
    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "env",
        error: "Missing CHATMETER_USERNAME or CHATMETER_PASSWORD"
      }));
    }

    // 4) LOGIN — capture token AND Set-Cookie
    const loginResp = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
      cache: "no-store"
    });

    const loginText = await loginResp.text();
    let loginJson = null;
    try { loginJson = JSON.parse(loginText); } catch { /* ignore */ }

    // Chatmeter may set a session cookie (e.g., connect.sid)
    // Node fetch exposes only the first cookie via headers.get('set-cookie'); newer runtimes can include multiple values.
    const setCookie = loginResp.headers.get("set-cookie") || "";

    // Token (if also returned)
    const token = loginJson?.token || loginJson?.access_token || "";

    if (!loginResp.ok && !setCookie && !token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false, stage: "login",
        status: loginResp.status,
        bodyPreview: loginText.slice(0, 600)
      }));
    }

    // 5) Try /reviews with different auth combos (cookie, cookie+bearer, bearer)
    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    const attempts = [];

    // If we got a cookie, try echoing it back
    if (setCookie) {
      // The server sent "Set-Cookie: name=value; Path=/; ..." — we must only send "Cookie: name=value"
      const cookiePair = setCookie.split(";")[0]; // take only "name=value"
      attempts.push({ name: "Cookie only", headers: { Cookie: cookiePair, Accept: "application/json" } });
      if (token) {
        attempts.push({ name: "Cookie + Bearer", headers: { Cookie: cookiePair, Authorization: `Bearer ${token}`, Accept: "application/json" } });
        attempts.push({ name: "Cookie + Token",  headers: { Cookie: cookiePair, Authorization: `Token ${token}`,  Accept: "application/json" } });
      }
    }

    // Header-only fallbacks (we already saw 401, but keep them for completeness)
    if (token) {
      attempts.push({ name: "Bearer only", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      attempts.push({ name: "Token only",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } });
    }

    const results = [];
    let chosen = null, data = null, finalStatus = null, finalText = null;

    for (const attempt of attempts) {
      try {
        const r = await fetch(url, { headers: attempt.headers, cache: "no-store" });
        finalStatus = r.status;
        finalText = await r.text().catch(() => "");
        if (r.ok) {
          try {
            const js = JSON.parse(finalText);
            const arr = Array.isArray(js?.data) ? js.data : Array.isArray(js) ? js : [];
            data = arr;
            chosen = attempt.name;
            results.push({ attempt: attempt.name, status: r.status, ok: true, sampleKeys: arr[0] ? Object.keys(arr[0]) : null });
            break;
          } catch {
            results.push({ attempt: attempt.name, status: r.status, ok: false, preview: finalText.slice(0, 300) });
          }
        } else {
          results.push({ attempt: attempt.name, status: r.status, ok: false, preview: (finalText || "").slice(0, 300) });
        }
      } catch (err) {
        results.push({ attempt: attempt.name, fetchError: String(err?.message || err) });
      }
    }

    if (!chosen) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "reviews-auth",
        loginStatus: loginResp.status,
        gotToken: !!token,
        gotSetCookie: !!setCookie,
        setCookiePreview: setCookie ? setCookie.split(";")[0] : null,
        url,
        lastStatus: finalStatus,
        results
      }));
    }

    // Success
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

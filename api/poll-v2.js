// Poller v2 — login, then probe /me to discover account/org scope (no Zendesk writes)
function envAny(...names) { for (const n of names) if (process.env[n]) return process.env[n]; return ""; }

export default async function handler(req, res) {
  try {
    // Method + CRON_SECRET auth
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

    // Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max = Math.max(1, parseInt(req.query.max || "5", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Env (accept mixed-case var names)
    const base = envAny("CHATMETER_V5_BASE") || "https://live.chatmeter.com/v5";
    const user = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
    const pass = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");
    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, stage: "env", error: "Missing CHATMETER_USERNAME or CHATMETER_PASSWORD" }));
    }

    // 1) LOGIN
    const lr = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
      cache: "no-store"
    });
    const loginText = await lr.text();
    let loginJson = null; try { loginJson = JSON.parse(loginText); } catch {}
    const token = loginJson?.token || loginJson?.access_token || "";
    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, stage: "login", status: lr.status, bodyPreview: loginText.slice(0, 800) }));
    }

    // 2) Probe /me with several header styles to get tenant/org info
    const attempts = [
      { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      { name: "Authorization: Token",  headers: { Authorization: `Token ${token}`,  Accept: "application/json" } }
    ];

    let me = null, meStatus = null, mePreview = null, meHeaders = null;
    for (const a of attempts) {
      const r = await fetch(`${base}/me`, { headers: a.headers, cache: "no-store" });
      meStatus = r.status;
      const txt = await r.text().catch(() => "");
      if (r.ok) {
        try { me = JSON.parse(txt); meHeaders = a.name; break; }
        catch { /* keep trying */ }
      } else {
        mePreview = txt.slice(0, 600);
      }
    }

    // If /me failed, return diagnostics so we can adjust
    if (!me) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        stage: "me",
        meStatus,
        mePreview,
        note: "If /me is not available on your tenant, we will probe organization/account endpoints next."
      }));
    }

    // Extract likely identifiers (best-effort keys)
    const keys = Object.keys(me || {});
    const orgId = me.organizationId || me.orgId || me.accountId || me.clientId || me.companyId || me.tenantId || null;

    // Return what we found so we can decide the correct reviews path
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      stage: "me-ok",
      meHeaders,
      keys,
      orgHints: {
        organizationId: me.organizationId || null,
        orgId: me.orgId || null,
        accountId: me.accountId || null,
        clientId: me.clientId || null,
        companyId: me.companyId || null,
        tenantId: me.tenantId || null
      },
      suggestion: "If org/account id is present, next we will try /organizations/{id}/reviews or /accounts/{id}/reviews"
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, stage: "top-catch", error: String(e?.message || e) }));
  }
}

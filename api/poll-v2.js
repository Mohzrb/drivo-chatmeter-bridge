// Poller v2 — login, discover scope, then fetch reviews under /{scope}/{id}/reviews (no Zendesk writes yet)

function envAny(...names) { for (const n of names) if (process.env[n]) return process.env[n]; return ""; }
function pickId(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["id","accountId","organizationId","orgId","clientId","companyId","businessId","locationId","profileId"];
  for (const k of keys) if (obj[k] != null) return String(obj[k]);
  return null;
}

export default async function handler(req, res) {
  try {
    // 1) Method + CRON auth
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

    // 3) Env (accept mixed case)
    const base = envAny("CHATMETER_V5_BASE") || "https://live.chatmeter.com/v5";
    const user = envAny("CHATMETER_USERNAME","Chatmeter_username","chatmeter_username");
    const pass = envAny("CHATMETER_PASSWORD","Chatmeter_password","chatmeter_password");
    if (!user || !pass) {
      res.statusCode = 200;
      res.setHeader("Content-Type","application/json");
      return res.end(JSON.stringify({ ok:false, stage:"env", error:"Missing CHATMETER_USERNAME or CHATMETER_PASSWORD" }));
    }

    // 4) LOGIN
    const lr = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type":"application/json", Accept:"application/json" },
      body: JSON.stringify({ username:user, password:pass }),
      cache: "no-store"
    });
    const loginTxt = await lr.text();
    let loginJson = null; try { loginJson = JSON.parse(loginTxt); } catch {}
    const token = loginJson?.token || loginJson?.access_token || "";
    if (!token) {
      res.statusCode = 200;
      res.setHeader("Content-Type","application/json");
      return res.end(JSON.stringify({ ok:false, stage:"login", status: lr.status, bodyPreview: loginTxt.slice(0,800) }));
    }

    // 5) Probe likely list endpoints to find your scope + id
    const scopes = ["accounts","organizations","clients","companies","groups","brands","locations","businesses","profiles"];
    const probeResults = [];
    let chosenScope = null, chosenId = null;

    for (const scope of scopes) {
      let status = null, text = null, arr = null, id = null;
      try {
        const r = await fetch(`${base}/${scope}?limit=1`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          cache: "no-store"
        });
        status = r.status;
        text = await r.text().catch(()=>"");
        if (r.ok) {
          try {
            const js = JSON.parse(text);
            const list = Array.isArray(js?.data) ? js.data : (Array.isArray(js) ? js : []);
            arr = list;
            id = list[0] ? pickId(list[0]) : null;
          } catch { /* ignore */ }
        }
      } catch (e) {
        probeResults.push({ scope, fetchError: String(e?.message || e) });
        continue;
      }
      probeResults.push({
        scope, status, ok: !!arr, sampleKeys: arr?.[0] ? Object.keys(arr[0]) : null, idPreview: id
      });
      if (arr && id) { chosenScope = scope; chosenId = id; break; }
    }

    if (!chosenScope || !chosenId) {
      res.statusCode = 200;
      res.setHeader("Content-Type","application/json");
      return res.end(JSON.stringify({
        ok:false, stage:"scope-discovery", base, probeResults
      }));
    }

    // 6) Try scoped reviews path
    const url = `${base}/${chosenScope}/${encodeURIComponent(chosenId)}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;
    const rr = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept:"application/json" },
      cache: "no-store"
    });
    const rtxt = await rr.text().catch(()=> "");
    if (!rr.ok) {
      res.statusCode = 200;
      res.setHeader("Content-Type","application/json");
      return res.end(JSON.stringify({
        ok:false, stage:"scoped-reviews", scope: chosenScope, id: chosenId, status: rr.status, bodyPreview: rtxt.slice(0,800)
      }));
    }
    let data = null; try { data = JSON.parse(rtxt); } catch {}
    const reviews = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    res.statusCode = 200;
    res.setHeader("Content-Type","application/json");
    return res.end(JSON.stringify({
      ok:true, stage:"chatmeter-ok", scope: chosenScope, id: chosenId, sinceIso,
      checked: reviews.length, sampleKeys: reviews[0] ? Object.keys(reviews[0]) : null
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type","application/json");
    return res.end(JSON.stringify({ ok:false, stage:"top-catch", error:String(e?.message || e) }));
  }
}

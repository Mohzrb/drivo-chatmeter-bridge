// /api/fix-missing.js
import { getProviderComment, buildInternalNote } from "./_helpers.js";

export default async function handler(req, res) {
  try {
    const want = process.env.CRON_SECRET;
    const got  = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) return res.status(401).json({ ok:false, error:"Unauthorized" });

    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    const ZD_SUB    = process.env.ZENDESK_SUBDOMAIN;
    const ZD_EMAIL  = process.env.ZENDESK_EMAIL;
    const ZD_TOK    = process.env.ZENDESK_API_TOKEN;
    const F_REVIEW  = process.env.ZD_FIELD_REVIEW_ID;
    const F_LOCNAME = process.env.ZD_FIELD_LOCATION_NAME;

    if (!CHM_TOKEN || !ZD_SUB || !ZD_EMAIL || !ZD_TOK || !F_REVIEW) {
      return res.status(500).send("Missing required envs.");
    }

    const minutes = +(req.query.minutes || 1440);
    const sinceISO = new Date(Date.now() - minutes*60*1000).toISOString().slice(0,19)+"Z";
    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOK}`).toString("base64");

    const q = `type:ticket tags:chatmeter created>${sinceISO}`;
    const result = await getJson(`https://${ZD_SUB}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(q)}`,
      { headers: { Authorization: auth } });

    const tickets = (result?.results || []);
    let fixed=0, skipped=0, checked=0, errors=0;

    for (const t of tickets) {
      checked++;
      try {
        const tr = await getJson(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`,
          { headers: { Authorization: auth } });
        const tk = tr?.ticket; if (!tk) { skipped++; continue; }

        const rid = (tk.custom_fields || []).find(f => String(f.id)===String(F_REVIEW))?.value;
        if (!rid) { skipped++; continue; }

        const det = await getJson(`${CHM_BASE}/reviews/${encodeURIComponent(rid)}`,
          { headers: { Authorization: CHM_TOKEN } });

        const text = getProviderComment(det?.contentProvider || det?.provider || "", det);
        if (!text) { skipped++; continue; }

        const provider = det?.contentProvider || det?.provider || "";
        const rating   = det?.rating ?? 0;
        const locId    = String(det?.locationId || "");
        const locName  = det?.locationName || "";

        const note = buildInternalNote({
          dt: det?.reviewDate || det?.createdAt || "",
          customerName: det?.reviewerUserName || det?.reviewer || "",
          customerEmail: det?.reviewerEmail || "",
          customerPhone: det?.reviewerPhone || "",
          provider, locationId: locId, locationName: locName,
          rating, comment: text, viewUrl: det?.reviewURL || det?.publicUrl || ""
        });

        await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ ticket: { comment: { body: note, public:false } } })
        });

        if (F_LOCNAME && locName) {
          await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: auth },
            body: JSON.stringify({ ticket: { custom_fields: [{ id:+F_LOCNAME, value:String(locName) }] } })
          });
        }
        fixed++;
      } catch { errors++; }
    }
    return res.status(200).json({ ok:true, since: sinceISO, checked, fixed, skipped, errors });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

async function getJson(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  try { return JSON.parse(t); } catch { return {}; }
}

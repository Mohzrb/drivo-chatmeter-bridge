// /api/fix-missing.js
// Backfill missing comments by refetching Chatmeter reviews, then update tickets' fields/tags.
// (Does NOT add an extra internal comment to avoid clutter.)

export const config = { runtime: "nodejs" };

function isGoodText(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (/^[a-f0-9]{24}$/i.test(s)) return false;
  return true;
}
function pickTextFromReview(r) {
  const direct = [r.text, r.reviewText, r.comment, r.body, r.content, r.message, r.review_body].find(isGoodText);
  if (isGoodText(direct)) return String(direct).trim();
  const rows = Array.isArray(r.reviewData) ? r.reviewData : (Array.isArray(r.data) ? r.data : []);
  for (const it of rows) {
    const key = String(it.name || it.key || "").toLowerCase();
    const val = it.value ?? it.text ?? it.detail ?? "";
    if (!isGoodText(val)) continue;
    if (/(comment|comments|review|review[_ ]?text|text|body|content|np_comment|free.*text|description)/.test(key)) {
      return String(val).trim();
    }
  }
  return "";
}
function toInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; }

async function zd() {
  const sub   = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;
  if (!sub || !email || !token) throw new Error("Missing Zendesk env");
  const auth = Buffer.from(`${email}/token:${token}`).toString("base64");
  const headers = { "Authorization": `Basic ${auth}`, "Content-Type": "application/json", "Accept": "application/json" };
  return { sub, headers };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // auth
  const want = process.env.CRON_SECRET || "";
  const got  = req.headers.authorization || req.headers.Authorization || "";
  if (want && got !== `Bearer ${want}`) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  if (!CHM_TOKEN) return res.status(500).json({ ok:false, error:"Missing CHATMETER_V5_TOKEN" });

  const minutes = toInt(req.query.minutes || "2880", 2880);
  const limit   = Math.min(500, toInt(req.query.limit || "200", 200));
  const sinceIso = new Date(Date.now() - minutes*60*1000).toISOString();

  try {
    const url = `${CHM_BASE}/reviews?limit=${limit}&sortField=reviewDate&sortOrder=DESC&updatedSince=${encodeURIComponent(sinceIso)}`;
    const r = await fetch(url, { headers: { Authorization: CHM_TOKEN }});
    const t = await r.text();
    if (!r.ok) return res.status(502).send(t);

    const data = JSON.parse(t || "{}");
    const items = Array.isArray(data.reviews) ? data.reviews : (data.results || []);

    const { sub, headers } = await zd();
    let checked = 0, fixed = 0, skipped = 0, errors = 0;

    for (const it of items) {
      checked++;
      const id = it?.id || it?.reviewId || it?.review_id || "";
      if (!id) { skipped++; continue; }

      const text = pickTextFromReview(it);
      if (!isGoodText(text)) { skipped++; continue; }

      // Ensure the ticket exists; then update fields/tags only
      const externalId = `chatmeter:${id}`;
      const sr = await fetch(`https://${sub}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(`external_id:${externalId}`)}`, { headers });
      const sTxt = await sr.text();
      if (!sr.ok) { errors++; continue; }
      const sData = JSON.parse(sTxt || "{}");
      const match = (sData.results || []).find(r => r.external_id === externalId);
      if (!match) { skipped++; continue; }

      const upd = {
        ticket: {
          external_id: externalId,
          tags: Array.from(new Set([...(match.tags || []), "chatmeter"])),
          custom_fields: [
            { id: Number(process.env.ZD_FIELD_REVIEW_ID), value: id },
            { id: Number(process.env.ZD_FIELD_LOCATION_ID), value: it.locationId || "" },
            { id: Number(process.env.ZD_FIELD_RATING), value: Number(it.rating || 0) },
            ...(process.env.ZD_FIELD_LOCATION_NAME
              ? [{ id: Number(process.env.ZD_FIELD_LOCATION_NAME), value: it.locationName || "" }]
              : [])
          ]
        }
      };
      const ur = await fetch(`https://${sub}.zendesk.com/api/v2/tickets/${match.id}.json`, {
        method: "PUT", headers, body: JSON.stringify(upd)
      });
      if (!ur.ok) { errors++; continue; }

      fixed++;
    }

    return res.json({ ok:true, since: sinceIso, checked, fixed, skipped, errors });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
}

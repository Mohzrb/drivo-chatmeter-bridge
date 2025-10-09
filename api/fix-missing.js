// /api/fix-missing.js
export default async function handler(req, res) {
  try {
    const want = process.env.CRON_SECRET;
    const got  = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

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

    let LOCMAP = {};
    try { LOCMAP = JSON.parse(process.env.CHM_LOCATION_MAP || "{}"); } catch {}

    const minutes = +(req.query.minutes || 1440);
    const limit   = +(req.query.limit || 200);

    const sinceISO = new Date(Date.now() - minutes*60*1000).toISOString().slice(0,19)+"Z";

    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_TOK}`).toString("base64");

    // Search tickets tagged chatmeter created after sinceISO
    const q = `type:ticket tags:chatmeter created>${sinceISO}`;
    const searchUrl = `https://${ZD_SUB}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(q)}`;
    const result = await jf(searchUrl, { headers: { Authorization: "Basic " + auth } });

    const tickets = (result?.results || []).slice(0, limit);
    let fixed = 0, skipped = 0, checked = 0, errors = 0;

    for (const t of tickets) {
      checked++;
      // get full ticket
      const tr = await jf(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
        headers: { Authorization: "Basic " + auth }
      });
      const tk = tr?.ticket;
      if (!tk) { skipped++; continue; }

      const rid = (tk.custom_fields || []).find(f => String(f.id) === String(F_REVIEW))?.value;
      if (!rid) { skipped++; continue; }

      // Pull Chatmeter detail
      let det = null;
      try {
        det = await jf(`${CHM_BASE}/reviews/${encodeURIComponent(rid)}`, { headers: { Authorization: CHM_TOKEN }});
      } catch { det = null; }

      const text = extractText(det);
      const provider = det?.contentProvider || det?.provider || tk.tags?.find(z=>z!=="chatmeter") || "";
      const rating = det?.rating ?? "";
      const locId  = String(det?.locationId || "");
      const locName= LOCMAP[locId] || det?.locationName || "";

      if (!text) { skipped++; continue; } // nothing to fix

      const block = formatNote({
        createdAt: det?.reviewDate || det?.createdAt || "",
        authorName: det?.reviewerUserName || det?.reviewer || "",
        provider, locationId: locId, locationName: locName,
        rating, text, publicUrl: det?.reviewURL || det?.publicUrl || ""
      });

      // Add an internal correction note
      await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + auth },
        body: JSON.stringify({ ticket: { comment: { body: block, public: false } } })
      });

      // Optional: set location name field if present
      if (F_LOCNAME && locName) {
        await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Basic " + auth },
          body: JSON.stringify({ ticket: { custom_fields: [{ id: +F_LOCNAME, value: String(locName) }] } })
        });
      }

      fixed++;
    }

    return res.status(200).json({ ok: true, since: sinceISO, checked, fixed, skipped, errors });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// shared helpers (same logic as poll-v2)
function extractText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const p = (obj.contentProvider || obj.provider || "").toUpperCase();
  if (p === "REVIEWBUILDER" && Array.isArray(obj.reviewData)) {
    const parts = [];
    for (const rd of obj.reviewData) {
      const nm = String(rd?.name || "").toLowerCase();
      if (nm.includes("open") || nm.includes("words") || nm.includes("comment") ||
          nm.includes("describe") || nm.includes("feedback")) {
        parts.push(String(rd?.value || "").trim());
      }
    }
    const joined = parts.filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }
  const candidates = [
    obj.comment, obj.text, obj.reviewText, obj.body, obj.content, obj.reviewerComment,
  ].map(x => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  if (candidates.length) { candidates.sort((a,b)=>b.length-a.length); return candidates.find(s=>!/^https?:\/\//i.test(s)) || candidates[0]; }
  let best = "";
  (function scan(o){ if (typeof o === "string") { const s=o.trim(); if (s.length>best.length && !/^https?:\/\//i.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s)) best=s; return; }
    if (Array.isArray(o)) o.forEach(scan); else if (o && typeof o==="object") Object.values(o).forEach(scan); })(obj);
  return best;
}
function formatNote(p) {
  const stars = typeof p.rating === "number" && p.rating > 0 ? "★".repeat(Math.min(5,p.rating)) : (p.rating?`${p.rating}★`:"(none)");
  return [
    "Review Information",
    "",
    `Date: ${p.createdAt || "(unknown)"}`,
    p.authorName ? `Customer: ${p.authorName}` : null,
    p.provider   ? `Provider: ${p.provider}`   : null,
    `Location: ${p.locationName || "Unknown"} (${p.locationId || "-"})`,
    `Rating: ${stars}`,
    "",
    "Comment:",
    (p.text && String(p.text).trim()) ? String(p.text).trim() : "(no text)",
    "",
    p.publicUrl ? "View in Chatmeter" : null
  ].filter(Boolean).join("\n");
}
async function jf(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  try { return JSON.parse(t); } catch { return {}; }
}

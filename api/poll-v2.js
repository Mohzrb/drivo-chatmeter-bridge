// /api/poll-v2.js
export default async function handler(req, res) {
  try {
    // --- auth: require CRON_SECRET unless you're testing locally
    const want = process.env.CRON_SECRET;
    const got = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-08" });
    }

    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
    if (!CHM_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");

    // query
    const minutes   = +(req.query.minutes || 1440); // default 24h
    const accountId = req.query.accountId || process.env.CHM_ACCOUNT_ID || "";
    const groupId   = req.query.groupId || "";
    const clientId  = req.query.clientId || "";
    const maxItems  = +(req.query.max || 200);
    // Always enrich, and by default require text
    const enrich    = true;
    const requireText = (req.query.requireText ?? "1") !== "0";

    // location name map (optional)
    let LOCMAP = {};
    try { LOCMAP = JSON.parse(process.env.CHM_LOCATION_MAP || "{}"); } catch {}

    const sinceIso  = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const qs = new URLSearchParams({
      limit: String(maxItems),
      sortField: "reviewDate",
      sortOrder: "DESC",
      updatedSince: sinceIso
    });
    if (accountId) qs.set("accountId", accountId);
    if (groupId)   qs.set("groupId", groupId);
    if (clientId)  qs.set("clientId", clientId);

    const url = `${CHM_BASE}/reviews?${qs.toString()}`;
    const list = await jf(url, { headers: { Authorization: CHM_TOKEN }});
    const items = Array.isArray(list?.reviews) ? list.reviews : (Array.isArray(list) ? list : []);

    let posted = 0, skipped = 0, errors = 0, checked = 0;
    const SELF_BASE = process.env.SELF_BASE_URL || ""; // recommend setting this
    for (const it of items) {
      checked++;
      const id = it?.id || it?.reviewId || it?.review_id;
      if (!id) { skipped++; continue; }

      let detail = it;
      if (enrich) {
        try {
          const durl = `${CHM_BASE}/reviews/${encodeURIComponent(id)}`;
          detail = await jf(durl, { headers: { Authorization: CHM_TOKEN }});
        } catch { /* keep list item as fallback */ }
      }

      const provider   = (detail?.contentProvider || detail?.provider || "").toUpperCase();
      const text       = extractText(detail) || extractText(it);
      const rating     = detail?.rating ?? it?.rating ?? 0;
      const locationId = String(detail?.locationId || it?.locationId || "");
      const locationName = LOCMAP[locationId] || detail?.locationName || it?.locationName || "Unknown";
      const authorName = detail?.reviewerUserName || detail?.reviewer || detail?.authorName || "Reviewer";
      const createdAt  = detail?.reviewDate || detail?.createdAt || "";
      const publicUrl  = detail?.reviewURL || detail?.publicUrl || "";

      if (requireText && !text) { skipped++; continue; }

      const payload = {
        id, provider, locationId, locationName, rating,
        authorName, createdAt, text, publicUrl
      };

      try {
        const hook = SELF_BASE ? `${SELF_BASE}/api/review-webhook` : `/api/review-webhook`;
        const r = await fetch(hook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!r.ok) { errors++; continue; }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-08",
      since: sinceIso,
      used_accountId: accountId || null,
      used_groupId: groupId || null,
      used_clientId: clientId || null,
      requireText,
      checked, posted, skipped, errors
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// ---- helpers ----
async function jf(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  try { return JSON.parse(t); } catch { return {}; }
}

// robust text extraction across providers
function extractText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const p = (obj.contentProvider || obj.provider || "").toUpperCase();

  // ReviewBuilder often places open text in reviewData entries
  if (p === "REVIEWBUILDER" && Array.isArray(obj.reviewData)) {
    const parts = [];
    for (const rd of obj.reviewData) {
      const nm = String(rd?.name || "").toLowerCase();
      if (
        nm.includes("open") || nm.includes("words") || nm.includes("comment") ||
        nm.includes("describe") || nm.includes("feedback")
      ) parts.push(String(rd?.value || "").trim());
    }
    const joined = parts.filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }

  // Common fields for Google/Yelp/Trustpilot/Facebook
  const candidates = [
    obj.comment, obj.text, obj.reviewText, obj.body, obj.content, obj.reviewerComment,
  ].map(x => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  if (candidates.length) {
    // pick the longest non-linky string
    candidates.sort((a,b)=>b.length-a.length);
    const best = candidates.find(s => !/^https?:\/\//i.test(s)) || candidates[0];
    return best;
  }

  // fallback: deep scan strings
  let best = "";
  (function scan(o){
    if (typeof o === "string") {
      const s = o.trim();
      if (s.length > best.length && !/^https?:\/\//i.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s))
        best = s;
      return;
    }
    if (Array.isArray(o)) o.forEach(scan);
    else if (o && typeof o === "object") Object.values(o).forEach(scan);
  })(obj);
  return best;
}

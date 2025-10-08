// Poll Chatmeter for recent reviews and forward each to /api/review-webhook
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const {
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID,
    CHM_LOCATION_MAP,
    SELF_BASE_URL,
    CRON_SECRET
  } = process.env;

  const version = "poller-v2-ultradeep-2025-10-08";

  // Protect with CRON_SECRET if present
  const gotAuth = req.headers.authorization || req.headers.Authorization || "";
  if (CRON_SECRET && gotAuth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized", version });
  }
  if (!CHATMETER_V5_TOKEN) return res.status(500).send("Missing env: CHATMETER_V5_TOKEN");

  // Parse query
  const urlObj = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(urlObj.searchParams.entries());

  // New: single-review debugging
  const singleId  = (q.id || "").trim();

  const minutes   = Number(q.minutes || q.m || 15);
  const clientId  = (q.clientId || "").trim();
  const accountId = (q.accountId || CHM_ACCOUNT_ID || "").trim();
  const groupId   = (q.groupId || "").trim();
  const providers = (q.providers || "").trim();        // e.g. GOOGLE,YELP
  const maxItems  = Math.min(Number(q.max || 50), 50); // safety cap
  const dryRun    = q.dry === "1" || q.dry === "true";
  const wantDebug = q.debug === "1" || q.debug === "true";

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const BASE = CHATMETER_V5_BASE;
  const TOKEN = CHATMETER_V5_TOKEN;

  const host = SELF_BASE_URL || `https://${req.headers.host}`;
  const forwardTo = `${host}/api/review-webhook`;

  // Providers for which we always pull detail
  const ALWAYS_DETAIL = new Set(["GOOGLE", "YELP", "TRUSTPILOT", "FACEBOOK", "BING", "MICROSOFT"]);

  let LOCATION_MAP = {};
  try { LOCATION_MAP = CHM_LOCATION_MAP ? JSON.parse(CHM_LOCATION_MAP) : {}; } catch {}

  // Helper to fetch JSON safely
  const fetchJson = async (url) => {
    const r = await fetch(url, { headers: { Authorization: TOKEN } });
    const t = await r.text();
    return { ok: r.ok, status: r.status, text: t, json: safeParse(t, {}) };
  };

  try {
    let items = [];
    let listUrl = "";
    let listRaw = "";

    if (singleId) {
      // ----- single review mode
      const det = await fetchJson(`${BASE}/reviews/${encodeURIComponent(singleId)}`);
      if (!det.ok) return res.status(502).send(`Chatmeter detail error: ${det.status} ${det.text}`);
      items = [det.json];
      listUrl = `${BASE}/reviews/${singleId}`;
      listRaw = det.text;
    } else {
      // ----- list mode
      const params = new URLSearchParams({
        limit: String(maxItems),
        sortField: "reviewDate",
        sortOrder: "DESC",
        updatedSince: sinceIso
      });
      if (clientId)  params.set("clientId", clientId);
      if (accountId) params.set("accountId", accountId);
      if (groupId)   params.set("groupId", groupId);
      if (providers) params.set("providers", providers);

      listUrl = `${BASE}/reviews?${params.toString()}`;

      const list = await fetchJson(listUrl);
      if (!list.ok) return res.status(502).send(`Chatmeter list error: ${list.status} ${list.text}`);
      listRaw = list.text;

      const j = list.json;
      items = Array.isArray(j?.reviews) ? j.reviews :
              Array.isArray(j) ? j :
              Array.isArray(j?.results) ? j.results : [];
    }

    let posted = 0, skipped = 0, errors = 0;
    const debugMissing = [];

    for (const r of items) {
      const id = r?.id || r?.reviewId || r?.review_id;
      if (!id) { skipped++; continue; }

      let provider = String(r.contentProvider || r.provider || r.source || "").toUpperCase();
      if (provider.includes("MICROSOFT")) provider = "BING";

      // Step 1: try text from list object
      let text = extractText(r);

      // Step 2: detail fetch when needed
      if (!text || ALWAYS_DETAIL.has(provider)) {
        try {
          const det = await fetchJson(`${BASE}/reviews/${encodeURIComponent(id)}`);
          if (det.ok) {
            text = extractText(det.json) || text;
            // If still nothing, capture a small debug blob (on demand)
            if (!text && wantDebug && debugMissing.length < 3) {
              debugMissing.push({
                id, provider,
                keys: Object.keys(det.json || {}).slice(0, 20),
                sample: stringifyShort(det.json, 1600)
              });
            }
          }
        } catch { /* ignore */ }
      }

      // Some reviews are truly rating-only; if text is blank after deep search we accept "(no text)"
      const locationId   = String(r.locationId || r.location_id || "");
      const locationName = LOCATION_MAP[locationId] || r.locationName || r.location || "Unknown";

      const payload = {
        id,
        provider,
        locationId,
        locationName,
        rating: typeof r.rating === "number" ? r.rating : Number(r.rating || 0),
        authorName: r.reviewerUserName || r.authorName || r.reviewer || "Chatmeter Reviewer",
        createdAt: r.reviewDate || r.createdAt || r.date || "",
        text: text || "",
        publicUrl: r.reviewURL || r.publicUrl || "",
        portalUrl: r.portalUrl || ""
      };

      if (dryRun) { posted++; continue; }

      try {
        const resp = await fetch(forwardTo, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) { errors++; continue; }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version,
      echo: {
        rawUrl: `/api/poll-v2?${new URLSearchParams(q).toString()}`,
        minutes, clientId, accountId, groupId, dry: dryRun, maxItems,
        singleId: singleId || null
      },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors,
      debug: wantDebug ? { url: listUrl, body_snippet: listRaw.slice(0, 300), missing: debugMissing } : undefined
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// ----------------- helpers -----------------

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

// Human-like string test
function looksLikeHumanText(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim();
  if (s.length < 15) return false;                  // too short to be a comment
  if (/^https?:\/\//i.test(s)) return false;        // url
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return false;  // iso date
  if (/^[A-F0-9\-]{20,}$/i.test(s)) return false;   // id-like
  // needs spaces and letters
  if (!/[a-z]/i.test(s) || !/\s/.test(s)) return false;
  return true;
}

// Deep search through any object for best comment candidate
function deepSearchForText(obj, preferKeyHint = false) {
  let best = "";
  const visit = (node, key = "") => {
    if (!node) return;
    if (typeof node === "string") {
      if (looksLikeHumanText(node)) {
        if (preferKeyHint) {
          // slightly prefer strings coming from commentish keys
          if (node.length >= best.length || /comment|text|review|feedback|message/i.test(key)) best = node.trim();
        } else {
          if (node.length > best.length) best = node.trim();
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, key);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, k);
    }
  };
  visit(obj);
  return best;
}

// Extract text using a layering strategy
function extractText(o) {
  if (!o || typeof o !== "object") return "";

  const pick = (v) => (typeof v === "string" && v.trim()) ? v.trim() : "";
  // 1) common direct keys
  for (const k of ["text","comment","body","reviewText","review_text","description","message","content"]) {
    const v = pick(o[k]);
    if (looksLikeHumanText(v)) return v;
  }
  // 2) nested 'review'
  if (o.review) {
    for (const k of ["text","comment","body","description","message"]) {
      const v = pick(o.review[k]);
      if (looksLikeHumanText(v)) return v;
    }
  }
  // 3) survey/reviewBuilder: reviewData[{name|label,value}]
  if (Array.isArray(o.reviewData)) {
    const hit = o.reviewData.find(x =>
      x && /comment|text|review|feedback|message/i.test(String(x.name||x.label||""))
    );
    const v = pick(hit?.value);
    if (looksLikeHumanText(v)) return v;
    // else try any long-ish value in reviewData
    for (const x of o.reviewData) {
      const vv = pick(x?.value);
      if (looksLikeHumanText(vv)) return vv;
    }
  }
  // 4) deep recursive catch-all (prefers commentish keys)
  const hinted = deepSearchForText(o, true);
  if (hinted) return hinted;

  // 5) last resort: longest human-like string anywhere
  return deepSearchForText(o, false);
}

function stringifyShort(obj, maxLen = 1200) {
  let s = "";
  try { s = JSON.stringify(obj); } catch {}
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

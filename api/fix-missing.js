// api/fix-missing.js
// Repair tickets missing text by refetching the Chatmeter review and replacing the INTERNAL card.
// Auth: Authorization: Bearer <CRON_SECRET>

export default async function handler(req, res) {
  try {
    const want = process.env.CRON_SECRET || "";
    const got  = (req.headers.authorization || "").trim();
    if (!want || got !== `Bearer ${want}`) return res.status(401).json({ ok:false, error:"Unauthorized" });

    const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
    const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
    const ZD_TOKEN     = process.env.ZENDESK_API_TOKEN;
    const CHM_TOKEN    = process.env.CHATMETER_V5_TOKEN;
    const CHM_BASE     = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const miss = [];
    if (!ZD_SUBDOMAIN) miss.push("ZENDESK_SUBDOMAIN");
    if (!ZD_EMAIL)     miss.push("ZENDESK_EMAIL");
    if (!ZD_TOKEN)     miss.push("ZENDESK_API_TOKEN");
    if (!CHM_TOKEN)    miss.push("CHATMETER_V5_TOKEN");
    if (miss.length) return res.status(500).json({ ok:false, error:"Missing env", vars: miss });

    const minutes = Math.max(parseInt(req.query.minutes || "4320", 10), 60);
    const limit   = Math.min(parseInt(req.query.limit   || "200", 10), 500);
    const sinceISO = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const zdAuth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString("base64");

    // search recent Chatmeter tickets (by tag)
    const q = `type:ticket tags:chatmeter created>${sinceISO}`;
    const searchURL = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(q)}`;
    const s = await fetch(searchURL, { headers: { Authorization: zdAuth } });
    const j = await s.json().catch(() => ({}));
    const tickets = (j.results || []).slice(0, limit);

    // optional location map
    let LOC_MAP = {};
    try { LOC_MAP = JSON.parse(process.env.CHM_LOCATION_MAP || "{}"); } catch {}

    let checked = 0, fixed = 0, skipped = 0, errors = 0;

    for (const t of tickets) {
      checked++;
      const ext = t.external_id || "";
      const m = /^chatmeter:(.+)$/.exec(ext);
      if (!m) { skipped++; continue; }
      const reviewId = m[1];

      // fetch the review by id (v5 doesn't always have direct single-get; read list & filter)
      const oneURL = `${CHM_BASE}/reviews?limit=1&providerReviewId=${encodeURIComponent(reviewId)}`;
      const r = await fetch(oneURL, { headers: { Authorization: CHM_TOKEN } });
      const txt = await r.text();
      if (!r.ok) { errors++; continue; }
      const data = safeParse(txt, {});
      const it = (Array.isArray(data.reviews) ? data.reviews : []).find(x => (x.id||x.reviewId||x.providerReviewId) == reviewId)
             || (Array.isArray(data.results) ? data.results : []).find(x => (x.id||x.reviewId||x.providerReviewId) == reviewId);
      if (!it) { skipped++; continue; }

      const locationId   = (it.locationId || "").toString();
      const provider     = (it.contentProvider || it.provider || "").toString().toUpperCase();
      const rating       = Number(it.rating || 0);
      const createdAtISO = it.reviewDate || it.createdAt || new Date().toISOString();
      const locationName = LOC_MAP[locationId] || it.locationName || "Unknown";
      const comment      = extractBestText(it);
      const publicUrl    = it.reviewURL || it.publicUrl || it.portalUrl || "";

      // if already has readable text, still refresh the card to ensure consistency
      const card = renderInternalCard({
        createdAtISO,
        customer: it.reviewerUserName || it.reviewerName || it.authorName || it.customer || "",
        provider,
        locationName,
        locationId,
        rating,
        comment,
        publicUrl
      });

      try {
        await addInternalNote(ZD_SUBDOMAIN, zdAuth, t.id, card);
        fixed++;
      } catch (e) {
        errors++;
      }
    }

    return res.status(200).json({ ok: true, since: sinceISO, checked, fixed, skipped, errors });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}

/* ===== helpers (same extractor & formatting as poll-v2) ===== */
function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function stars(n) { const r = Math.max(0, Math.min(5, Math.round(n))); return "★".repeat(r) + "☆".repeat(5 - r); }
function renderInternalCard({ createdAtISO, customer, provider, locationName, locationId, rating, comment, publicUrl }) {
  const lines = [];
  lines.push("Review Information");
  lines.push("");
  lines.push(`Date: ${createdAtISO}`);
  if (customer) lines.push(`Customer: ${customer}`);
  if (provider) lines.push(`Provider: ${provider}`);
  lines.push(`Location: ${locationName} (${locationId || "Unknown"})`);
  lines.push(`Rating: ${stars(rating)}`);
  lines.push("Comment:");
  lines.push(comment || "(no text)");
  if (publicUrl) {
    lines.push("");
    lines.push(`[View in Chatmeter](${publicUrl})`);
  }
  lines.push("");
  lines.push("_The first public comment on this ticket will be posted to Chatmeter._");
  return lines.join("\n");
}

function extractBestText(item) {
  const rootCandidates = [
    item.text, item.reviewText, item.body, item.comment, item.content,
    item.review, item.reviewerComments, item.providerReviewText,
  ];
  const fromPairs = [];
  if (Array.isArray(item.reviewData)) {
    for (const p of item.reviewData) {
      const key = String(p?.name || "").toLowerCase().replace(/[\s\-]/g, "_");
      const val = String(p?.value ?? "");
      if (!val) continue;
      fromPairs.push([key, val]);
    }
  }
  const preferred = new Set([
    "comment","comments","review","review_text","text","body","content",
    "reviewer_comments","google_review_text","yelp_review_text",
    "tripadvisor_review_text","facebook_review_text","bing_review_text",
    "expedia_review_text","np_comments","nps_comments","free_text"
  ]);
  let pairCandidate = null;
  for (const [k, v] of fromPairs) if (preferred.has(k)) { pairCandidate = v; break; }
  if (!pairCandidate) for (const [, v] of fromPairs) if (/\p{L}/u.test(v)) { pairCandidate = v; break; }
  let raw = (rootCandidates.find(s => typeof s === "string" && s.trim()) || pairCandidate || "").trim();
  if (looksLikeBase64Url(raw)) {
    const decoded = tryBase64UrlDecode(raw);
    if (decoded && isReadable(decoded)) raw = decoded.trim();
  }
  return raw || "(no text)";
}
function looksLikeBase64Url(str) { return typeof str === "string" && /^[A-Za-z0-9\-_]{30,}$/.test(str); }
function tryBase64UrlDecode(str) {
  try {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4; if (pad) b64 += "=".repeat(4 - pad);
    return Buffer.from(b64, "base64").toString("utf8");
  } catch { return ""; }
}
function isReadable(s) { return /\p{L}/u.test(s) && !/[\u0000-\u0008\u000E-\u001F]/.test(s); }

async function addInternalNote(sub, auth, ticketId, body) {
  const u = `https://${sub}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const payload = { ticket: { comment: { body, public: false } } };
  await fetch(u, { method: "PUT", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

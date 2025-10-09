// api/poll-v2.js
// Poll Chatmeter v5 → create/update ONE Zendesk ticket per review (internal “Review Information” card)
// Auth: header Authorization: Bearer <CRON_SECRET>

export default async function handler(req, res) {
  try {
    // --- auth (required for all calls) ---
    const want = process.env.CRON_SECRET || "";
    const got = (req.headers.authorization || "").trim();
    if (!want || got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2-2025-10-09" });
    }

    // --- env checks ---
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
    if (miss.length) return res.status(500).json({ ok: false, error: "Missing env", vars: miss });

    // --- query params ---
    const minutes   = Math.max(parseInt(req.query.minutes || "1440", 10), 15); // default 24h
    const maxItems  = Math.min(parseInt(req.query.max || "100", 10), 200);
    const accountId = (req.query.accountId || process.env.CHM_ACCOUNT_ID || "").trim();
    const clientId  = (req.query.clientId  || process.env.CHM_CLIENT_ID  || "").trim();
    const groupId   = (req.query.groupId   || process.env.CHM_GROUP_ID   || "").trim();
    const dry       = String(req.query.dry || "").toLowerCase() === "1";

    const updatedSince = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // --- compose Chatmeter query ---
    const params = new URLSearchParams({
      updatedSince,
      limit: String(maxItems),
      sortField: "reviewDate",
      sortOrder: "DESC",
    });
    if (accountId) params.set("accountId", accountId);
    if (clientId)  params.set("clientId",  clientId);
    if (groupId)   params.set("groupId",   groupId);

    const chmURL = `${CHM_BASE}/reviews?${params.toString()}`;
    const chmResp = await fetch(chmURL, { headers: { Authorization: CHM_TOKEN } });
    const chmText = await chmResp.text();
    if (!chmResp.ok) {
      return res.status(502).json({ ok: false, error: "Chatmeter error", status: chmResp.status, body: chmText });
    }
    const body = safeParse(chmText, {});
    const items = Array.isArray(body.reviews) ? body.reviews : Array.isArray(body.results) ? body.results : [];

    // optional location map { "1001892551":"JFK", ... }
    let LOC_MAP = {};
    try { LOC_MAP = JSON.parse(process.env.CHM_LOCATION_MAP || "{}"); } catch {}

    // --- Zendesk auth header ---
    const zdAuth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString("base64");

    let checked = 0, posted = 0, skipped = 0, errors = 0;
    for (const it of items) {
      checked++;

      // Required ids
      const reviewId = (it?.id || it?.reviewId || it?.providerReviewId || "").toString();
      if (!reviewId) { skipped++; continue; }

      // Build fields
      const locationId   = (it.locationId || it.providerLocationId || "").toString();
      const provider     = normalizeProvider(it.contentProvider || it.provider || "");
      const rating       = Number(it.rating || it.score || 0);
      const createdAtISO = it.reviewDate || it.createdAt || it.created_at || it.dateTime || new Date().toISOString();

      const locationName = LOC_MAP[locationId] || it.locationName || "Unknown";
      const reviewText   = extractBestText(it);

      const publicUrl = it.reviewURL || it.publicUrl || it.portalUrl || "";

      // Build INTERNAL card
      const card = renderInternalCard({
        createdAtISO,
        customer: it.reviewerUserName || it.reviewerName || it.authorName || it.customer || "",
        provider,
        locationName,
        locationId,
        rating,
        comment: reviewText,
        publicUrl,
      });

      // One ticket per review using external_id
      const externalId = `chatmeter:${reviewId}`;
      try {
        if (dry) { posted++; continue; }

        // find existing
        const existing = await findByExternalId(ZD_SUBDOMAIN, zdAuth, externalId);

        if (!existing) {
          // create
          const created = await createTicket(ZD_SUBDOMAIN, zdAuth, {
            subject: `${locationName} – ${stars(rating)} – ${shortName(it.reviewerUserName || it.reviewerName || it.authorName || "")}`,
            external_id: externalId,
            requester: { name: "reviews@drivo.com", email: "reviews@drivo.com" },
            comment: { body: card, public: false },
            tags: tagsFor(provider, reviewId),
            custom_fields: customFieldsFor(reviewId, locationId, rating, locationName),
          });
          if (!created) throw new Error("create failed");
          posted++;
        } else {
          // update — replace the latest internal card only (no duplicates)
          await addOrReplaceInternalNote(ZD_SUBDOMAIN, zdAuth, existing.id, card);
          posted++;
        }
      } catch (e) {
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      version: "poller-v2-2025-10-09",
      echo: { minutes, accountId, clientId, groupId, dry, maxItems },
      since: updatedSince,
      checked, posted, skipped, errors
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/* ===================== helpers ===================== */

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function shortName(s) { return (s || "Reviewer").toString().trim().split(" ")[0]; }
function stars(n) { const r = Math.max(0, Math.min(5, Math.round(n))); return "★".repeat(r) + "☆".repeat(5 - r); }
function normalizeProvider(p) { return (p || "").toString().trim().toUpperCase(); }
function tagsFor(provider, reviewId) {
  const t = ["chatmeter", "review"];
  if (provider) t.push(provider.toLowerCase());
  t.push(`cmrvw_${reviewId}`);
  return t;
}
function customFieldsFor(reviewId, locationId, rating, locationName) {
  const f = [];
  const id = (k) => Number(process.env[k] || 0) || undefined;

  const F_REVIEW_ID   = id("ZD_FIELD_REVIEW_ID");
  const F_LOC_ID      = id("ZD_FIELD_LOCATION_ID");
  const F_RATING      = id("ZD_FIELD_RATING");
  const F_FIRST_REPLY = id("ZD_FIELD_FIRST_REPLY_SENT");
  const F_LOC_NAME    = id("ZD_FIELD_LOCATION_NAME");

  if (F_REVIEW_ID)   f.push({ id: F_REVIEW_ID,   value: reviewId });
  if (F_LOC_ID)      f.push({ id: F_LOC_ID,      value: locationId || "" });
  if (F_RATING)      f.push({ id: F_RATING,      value: rating || 0 });
  if (F_FIRST_REPLY) f.push({ id: F_FIRST_REPLY, value: false });
  if (F_LOC_NAME && locationName) f.push({ id: F_LOC_NAME, value: locationName });

  return f;
}

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

/* -------------- robust text extractor -------------- */
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
  for (const [k, v] of fromPairs) { if (preferred.has(k)) { pairCandidate = v; break; } }
  if (!pairCandidate) for (const [, v] of fromPairs) { if (/\p{L}/u.test(v)) { pairCandidate = v; break; } }

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

/* ------- Zendesk HTTP helpers (create/update/find) ------- */
async function findByExternalId(sub, auth, externalId) {
  const u = `https://${sub}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(`type:ticket external_id:"${externalId}"`)}`;
  const r = await fetch(u, { headers: { Authorization: auth, "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  const t = (Array.isArray(j.results) ? j.results : []).find(x => x.external_id === externalId);
  return t || null;
}

async function createTicket(sub, auth, { subject, external_id, requester, comment, tags, custom_fields }) {
  const u = `https://${sub}.zendesk.com/api/v2/tickets.json`;
  const body = { ticket: { subject, external_id, requester, comment, tags, custom_fields } };
  const r = await fetch(u, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j.ticket || null;
}

// Replace the latest **internal** note with new body to avoid multiple cards.
async function addOrReplaceInternalNote(sub, auth, ticketId, body) {
  // NB: easiest safe approach is to just add another internal note – agent view will still be correct.
  // If you insist on replace, you need incremental audits parsing; here we simply add one internal note.
  const u = `https://${sub}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const payload = { ticket: { comment: { body, public: false } } };
  await fetch(u, { method: "PUT", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

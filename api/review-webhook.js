// /api/review-webhook.js
// Chatmeter -> Zendesk: create/update ticket with ONE INTERNAL card.
//
// Key points:
// - Two-ID strategy:
//    * dedupeId  = providerReviewId || id || reviewId      -> Zendesk external_id
//    * lookupId  = id || reviewId || providerReviewId      -> Chatmeter /reviews/{id}
// - REVIEWBUILDER: ALWAYS fetch detail and extract free-text from reviewData.
// - GOOGLE/YELP/others: fetch detail only if incoming text is empty/junk.

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  isBooleanString,
  normalizeProvider,
  pickCustomerContact,
} from "./_helpers.js";

/* ---------- tiny local guard for junk strings (ids/urls/booleans/ratings/tokens) ---------- */
function isJunkComment(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();

  if (isBooleanString(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;                       // URL
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;                  // ISO date
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;                  // 5, 4.0
  if (/^★{1,5}$/.test(t)) return true;                             // ★★★★☆
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;                     // 4/5
  if (/^[A-Fa-f0-9]{24}$/.test(t)) return true;                    // 24-hex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return true; // uuid
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(t) && !/\s/.test(t) && !/[aeiou]/i.test(t)) return true; // token-ish

  return false;
}

/* ---------- Fetch Chatmeter review detail trying multiple id/path variants ---------- */
async function fetchReviewDetailSmart({ idCandidates, chmBase, token, accountId }) {
  const ids = (Array.isArray(idCandidates) ? idCandidates : [idCandidates]).filter(Boolean);
  if (!ids.length || !token) return null;
  const headers = { Authorization: token };

  for (const idRaw of ids) {
    const id = String(idRaw);
    const paths = [
      `/reviews/${encodeURIComponent(id)}`,
      `/reviewBuilder/reviews/${encodeURIComponent(id)}`,
    ];
    for (const p of paths) {
      const url = `${chmBase}${p}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : "");
      try {
        const r = await fetch(url, { headers });
        const t = await r.text();
        if (!r.ok) continue;
        try { return JSON.parse(t); } catch { return {}; }
      } catch { /* try next */ }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL,
    ZENDESK_API_TOKEN,
    ZD_FIELD_REVIEW_ID,
    ZD_FIELD_LOCATION_ID,
    ZD_FIELD_RATING,
    ZD_FIELD_FIRST_REPLY_SENT, // not used here; kept for compatibility
    ZD_FIELD_LOCATION_NAME,    // optional
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "",
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING && "ZD_FIELD_RATING",
    !CHATMETER_V5_TOKEN && "CHATMETER_V5_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const inBody = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // ---------- IDs (dedupe vs lookup)
    const rawProviderReviewId = inBody.providerReviewId || inBody.provider_review_id;
    const rawId               = inBody.id || inBody.reviewId;

    const dedupeId = String(rawProviderReviewId || rawId || ""); // Zendesk external_id
    const lookupId = String(rawId || rawProviderReviewId || ""); // Chatmeter detail
    const reviewId = rawId || rawProviderReviewId || "";         // for field display

    // Build a candidate list for detail fetch
    const idCandidates = [
      lookupId || null,
      reviewId || null,
      rawProviderReviewId || null,
    ].filter(Boolean);

    // ---------- Normalize core fields
    const provider     = normalizeProvider(inBody.provider || inBody.contentProvider || "");
    const locationId   = String(inBody.locationId || "");
    const locationName = String(inBody.locationName || "");
    const rating       = Number(inBody.rating || 0);
    const createdAt    = inBody.createdAt || inBody.reviewDate || new Date().toISOString();
    const authorName   = inBody.authorName || inBody.reviewerUserName || inBody.reviewer || "";
    const publicUrl    = inBody.publicUrl || inBody.reviewURL || inBody.portalUrl || "";
    const contactIn    = pickCustomerContact(inBody); // { email, phone }

    // ---------- Comment (ALWAYS fetch for REVIEWBUILDER; conditional for others)
    let comment = isNonEmptyString(inBody.text) ? inBody.text.trim() : "";
    let det = null;

    if (provider === "REVIEWBUILDER") {
      det = await fetchReviewDetailSmart({
        idCandidates,
        chmBase: CHATMETER_V5_BASE,
        token: CHATMETER_V5_TOKEN,
        accountId: CHM_ACCOUNT_ID,
      });
      if (det) {
        const extracted = getProviderComment(provider, det);
        if (isNonEmptyString(extracted) && !isJunkComment(extracted)) comment = extracted.trim();
      }
    }

    if (!isNonEmptyString(comment) || isJunkComment(comment)) {
      if (!det) {
        det = await fetchReviewDetailSmart({
          idCandidates,
          chmBase: CHATMETER_V5_BASE,
          token: CHATMETER_V5_TOKEN,
          accountId: CHM_ACCOUNT_ID,
        });
      }
      if (det) {
        const extracted = getProviderComment(provider, det);
        if (isNonEmptyString(extracted) && !isJunkComment(extracted)) comment = extracted.trim();
        if (!contactIn.email && isNonEmptyString(det.reviewerEmail)) inBody.authorEmail = det.reviewerEmail;
        if (!contactIn.phone && isNonEmptyString(det.reviewerPhone)) inBody.authorPhone = det.reviewerPhone;
      }
    }

    if (!isNonEmptyString(comment) || isJunkComment(comment)) comment = ""; // note renders "(no text)"

    const contact = {
      email: inBody.authorEmail || contactIn.email || "",
      phone: inBody.authorPhone || contactIn.phone || "",
    };

    // ---------- Zendesk helpers
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, {
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    });
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    // ---------- De-dupe by external_id
    const external_id = `chatmeter:${dedupeId || reviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
    const dupRes = await zGet(`/search.json?query=${q}`);
    if (!dupRes.ok) {
      const t = await dupRes.text();
      return res.status(400).send(`Zendesk lookup failed: ${dupRes.status}\n${t}`);
    }
    const dupJson = await dupRes.json();
    let ticketId = dupJson?.results?.[0]?.id || null;

    // ---------- Custom fields
    const custom_fields = [
      { id: +ZD_FIELD_REVIEW_ID,   value: String(reviewId || dedupeId || "") },
      { id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") },
      { id: +ZD_FIELD_RATING,      value: rating || 0 },
    ];
    if (ZD_FIELD_LOCATION_NAME) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName || "" });
    }

    // ---------- Internal note
    const note = buildInternalNote({
      dt: createdAt,
      customerName: authorName,
      customerEmail: contact.email,
      customerPhone: contact.phone,
      provider,
      locationName,
      locationId,
      rating,
      comment,
      viewUrl: publicUrl,
    });

    const requesterEmail = "reviews@drivo.com";
    const tags = ["chatmeter", (provider || "chatmeter").toLowerCase(), `cmrvw_${dedupeId || reviewId}`];

    if (!ticketId) {
      // Create new ticket
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags,
          custom_fields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      return res.status(200).json({ ok: true, action: "created", id: j?.ticket?.id, externalId: external_id });
    } else {
      // Update existing ticket (avoid duplicate internal note)
      const payload = { ticket: { external_id, tags, custom_fields } };
      const r = await zSend(`/tickets/${ticketId}.json`, "PUT", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk update failed: ${r.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: ticketId, externalId: external_id });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// /api/review-webhook.js
// Creates/updates a Zendesk ticket **with a single INTERNAL card**.
// If incoming "text" is missing/boolean, we fetch review detail from Chatmeter
// and extract the proper open-text (esp. REVIEWBUILDER).

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  isBooleanString,
  normalizeProvider,
} from "./_helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // --- Zendesk env
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID   = process.env.ZD_FIELD_REVIEW_ID;
  const F_LOCATION_ID = process.env.ZD_FIELD_LOCATION_ID;
  const F_RATING      = process.env.ZD_FIELD_RATING;
  const F_FIRST       = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const F_LOCNAME     = process.env.ZD_FIELD_LOCATION_NAME;    // optional

  const MISSING = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !F_REVIEW_ID  && "ZD_FIELD_REVIEW_ID",
    !F_LOCATION_ID&& "ZD_FIELD_LOCATION_ID",
    !F_RATING     && "ZD_FIELD_RATING",
    !F_FIRST      && "ZD_FIELD_FIRST_REPLY_SENT",
  ].filter(Boolean);
  if (MISSING.length) return res.status(500).send(`Missing env: ${MISSING.join(", ")}`);

  // --- Chatmeter env (for detail backfill)
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId || body.providerReviewId;
    const provider     = normalizeProvider(body.provider || body.contentProvider || "");
    const locationId   = body.locationId || "";
    const locationName = body.locationName || "";
    const rating       = Number(body.rating || 0);
    const createdAt    = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName   = body.authorName || body.reviewerUserName || body.reviewer || "";
    const publicUrl    = body.publicUrl || body.reviewURL || body.portalUrl || "";

    // incoming comment
    let comment = isNonEmptyString(body.text) && !isBooleanString(body.text)
      ? body.text.trim()
      : "";

    // Fallback: fetch full review detail (esp. for REVIEWBUILDER & some Yelp/Google cases)
    if (!comment && CHM_TOKEN && reviewId) {
      const detail = await fetchReviewDetailSmart({
        id: reviewId, chmBase: CHM_BASE, token: CHM_TOKEN,
        accountId: process.env.CHM_ACCOUNT_ID,
      });
      if (detail) {
        comment = getProviderComment(provider || detail.contentProvider, detail);
      }
    }

    const external_id  = `chatmeter:${reviewId}`;
    const tagProvider  = (provider || "chatmeter").toLowerCase();

    const note = buildInternalNote({
      dt: createdAt,
      customer: authorName,
      provider,
      locationName,
      locationId,
      rating,
      comment,
      viewUrl: publicUrl,
    });

    // --- Zendesk helpers
    const zBase = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zGet  = (p) => fetch(`${zBase}${p}`, { headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }});
    const zSend = (p, method, payload) =>
      fetch(`${zBase}${p}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });

    // 1) De-dup by external_id
    let ticketId = null;
    {
      const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
      const r = await zGet(`/search.json?query=${q}`);
      if (!r.ok) {
        const t = await r.text();
        return res.status(400).send(`Zendesk lookup failed: ${r.status}\n${t}`);
      }
      const data = await r.json();
      ticketId = data?.results?.[0]?.id || null;
    }

    const customFields = [
      { id: +F_REVIEW_ID,   value: String(reviewId || "") },
      { id: +F_LOCATION_ID, value: String(locationId || "") },
      { id: +F_RATING,      value: rating || 0 },
    ];
    if (F_LOCNAME) customFields.push({ id: +F_LOCNAME, value: locationName || "" });

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", tagProvider, `cmrvw_${reviewId}`];

    if (!ticketId) {
      // 2) Create ticket
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags: commonTags,
          custom_fields: customFields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      ticketId = j?.ticket?.id;
      return res.status(200).json({ ok: true, action: "created", id: ticketId, externalId: external_id });
    } else {
      // 3) Update ticket: append single INTERNAL card
      const payload = {
        ticket: {
          external_id,
          tags: commonTags,
          custom_fields: customFields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets/${ticketId}.json`, "PUT", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk update failed: ${r.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: ticketId, externalId: external_id });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/** -------------------- Chatmeter detail fetch (id OR providerReviewId) ---- **/
async function fetchReviewDetailSmart({ id, chmBase, token, accountId }) {
  if (!id || !token) return null;
  const headers = { Authorization: token };
  const tryPaths = [
    `/reviews/${encodeURIComponent(String(id))}`,
    `/reviewBuilder/reviews/${encodeURIComponent(String(id))}`,
  ];
  for (const p of tryPaths) {
    const url = `${chmBase}${p}${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      try { return JSON.parse(t); } catch { return {}; }
    } catch { /* next */ }
  }
  return null;
}

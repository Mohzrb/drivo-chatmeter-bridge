// /api/review-webhook.js — force-fetch detail for RB + debug hook

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  normalizeProvider,
  pickCustomerContact,
} from "./_helpers.js";

/* Fetch Chatmeter detail trying multiple paths & ids */
async function fetchReviewDetailSmart({ idCandidates, chmBase, token, accountId }) {
  const ids = (Array.isArray(idCandidates) ? idCandidates : [idCandidates]).filter(Boolean).map(String);
  const headers = { Authorization: token };
  const tried = [];
  for (const id of ids) {
    for (const path of [`/reviews/${encodeURIComponent(id)}`, `/reviewBuilder/reviews/${encodeURIComponent(id)}`]) {
      const url = `${chmBase}${path}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : "");
      tried.push(url);
      try {
        const r = await fetch(url, { headers });
        const t = await r.text();
        if (!r.ok) continue;
        try { return { json: JSON.parse(t), tried }; } catch { return { json: {}, tried }; }
      } catch { /* try next */ }
    }
  }
  return { json: null, tried };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN,
    ZD_FIELD_REVIEW_ID, ZD_FIELD_LOCATION_ID, ZD_FIELD_RATING, ZD_FIELD_LOCATION_NAME,
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN, CHM_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "",
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
    const debugMode = req.headers["x-debug"] === "1" || req.query?.debug === "1";

    const rawProviderReviewId = inBody.providerReviewId || inBody.provider_review_id;
    const rawId               = inBody.id || inBody.reviewId;
    const dedupeId = String(rawProviderReviewId || rawId || "");
    const lookupId = String(rawId || rawProviderReviewId || "");
    const reviewId = rawId || rawProviderReviewId || "";

    const provider     = normalizeProvider(inBody.provider || inBody.contentProvider || "");
    const locationId   = String(inBody.locationId || "");
    const locationName = String(inBody.locationName || "");
    const rating       = Number(inBody.rating || 0);
    const createdAt    = inBody.createdAt || inBody.reviewDate || new Date().toISOString();
    const authorName   = inBody.authorName || inBody.reviewerUserName || inBody.reviewer || "";
    const publicUrl    = inBody.publicUrl || inBody.reviewURL || inBody.portalUrl || "";
    const contactIn    = pickCustomerContact(inBody);

    // always try to fetch detail for RB; otherwise only if incoming text is empty
    const needFetch = provider === "REVIEWBUILDER" || !isNonEmptyString(inBody.text);
    let detail = null;
    let tried = [];
    if (needFetch) {
      const resDet = await fetchReviewDetailSmart({
        idCandidates: [lookupId, reviewId, rawProviderReviewId],
        chmBase: CHATMETER_V5_BASE,
        token: CHATMETER_V5_TOKEN,
        accountId: CHM_ACCOUNT_ID,
      });
      detail = resDet.json;
      tried = resDet.tried;
    }

    let comment = "";
    if (detail) {
      comment = getProviderComment(provider, detail);
      if (!isNonEmptyString(comment)) {
        // some payloads have nested 'review' object
        if (detail.review && typeof detail.review === "object") {
          comment = getProviderComment(provider, detail.review);
        }
      }
    }
    if (!isNonEmptyString(comment)) {
      comment = getProviderComment(provider, inBody) || "";
    }

    // Zendesk helpers
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (p) => fetch(`${zBase}${p}`, { headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }});
    const zSend = (p, m, payload) => fetch(`${zBase}${p}`, {
      method: m, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    const external_id = `chatmeter:${dedupeId || reviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
    const dupRes = await zGet(`/search.json?query=${q}`);
    if (!dupRes.ok) {
      const t = await dupRes.text();
      return res.status(400).send(`Zendesk lookup failed: ${dupRes.status}\n${t}`);
    }
    const dupJson = await dupRes.json();
    let ticketId = dupJson?.results?.[0]?.id || null;

    const custom_fields = [
      { id: +ZD_FIELD_REVIEW_ID,   value: String(reviewId || dedupeId || "") },
      { id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") },
      { id: +ZD_FIELD_RATING,      value: rating || 0 },
    ];
    if (ZD_FIELD_LOCATION_NAME) custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName || "" });

    const note = buildInternalNote({
      dt: createdAt,
      customerName: authorName,
      customerEmail: contactIn.email,
      customerPhone: contactIn.phone,
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
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id, tags, custom_fields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      return res.status(200).json({ ok: true, action: "created", id: j?.ticket?.id, externalId: external_id, debug: debugMode ? { tried, provider, commentLen: comment?.length || 0 } : undefined });
    } else {
      const payload = { ticket: { external_id, tags, custom_fields } };
      const r = await zSend(`/tickets/${ticketId}.json`, "PUT", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk update failed: ${r.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: ticketId, externalId: external_id, debug: debugMode ? { tried, provider, commentLen: comment?.length || 0 } : undefined });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

// /api/review-webhook.js
// Create/update Zendesk ticket with ONE INTERNAL card.
// If incoming text is missing/boolean/junk, fetch Chatmeter review detail
// (works for GOOGLE, YELP, REVIEWBUILDER, TRUSTPILOT, etc.) and extract text.

import {
  isNonEmptyString,
  isBooleanString,
  normalizeProvider,
  extractAnyText,
  getProviderComment,
  buildInternalNote,
} from "./_helpers.js";

/** Fetch Chatmeter review detail by id or providerReviewId. */
async function fetchReviewDetailSmart({ id, providerReviewId, chmBase, token, accountId }) {
  if (!token) return null;
  const headers = { Authorization: token };
  const tryIds = [id, providerReviewId].filter(Boolean).map(String);

  for (const rid of tryIds) {
    const url = `${chmBase}/reviews/${encodeURIComponent(rid)}${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      try { return JSON.parse(t); } catch { return {}; }
    } catch { /* next */ }
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
    ZD_FIELD_FIRST_REPLY_SENT,
    ZD_FIELD_LOCATION_NAME, // optional
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID = "",      // optional but helps detail endpoint
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL     && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID  && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID&& "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING     && "ZD_FIELD_RATING",
    !ZD_FIELD_FIRST_REPLY_SENT && "ZD_FIELD_FIRST_REPLY_SENT",
    !CHATMETER_V5_TOKEN && "CHATMETER_V5_TOKEN"
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    // ids
    const reviewId = body.id || body.reviewId || body.providerReviewId || "";
    const providerReviewId = body.providerReviewId || "";
    if (!reviewId && !providerReviewId) return res.status(400).send("Missing review id");

    // basic meta
    const provider = normalizeProvider(body.provider || body.contentProvider || "");
    const locationId = body.locationId || "";
    const locationName = body.locationName || "";
    const rating = Number(body.rating || 0);
    const createdAt = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName = body.authorName || body.reviewerUserName || body.reviewer || "";
    const publicUrl  = body.publicUrl || body.reviewURL || body.portalUrl || "";

    // try incoming text first
    let comment = "";
    if (isNonEmptyString(body.text) && !isBooleanString(body.text)) {
      // ignore obvious noise
      const t = String(body.text).trim();
      comment = (!/^[A-Za-z0-9+/_=-]{40,}$/.test(t)) ? t : "";
    }
    if (!isNonEmptyString(comment)) {
      const direct = getProviderComment(provider, body);
      if (isNonEmptyString(direct)) comment = direct;
    }

    // fallback: fetch detail for ANY provider if still empty/junk
    if (!isNonEmptyString(comment)) {
      const detail = await fetchReviewDetailSmart({
        id: reviewId,
        providerReviewId,
        chmBase: CHATMETER_V5_BASE,
        token: CHATMETER_V5_TOKEN,
        accountId: CHM_ACCOUNT_ID
      });

      const extracted = extractAnyText(detail || {});
      if (isNonEmptyString(extracted)) comment = extracted;
    }

    // build internal note
    const note = buildInternalNote({
      dt: createdAt,
      customer: authorName,
      provider,
      locationName,
      locationId,
      rating,
      comment,
      viewUrl: publicUrl
    });

    // Zendesk helpers
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, { headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" }});
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });

    // de-dupe by external id
    const external_id = `chatmeter:${reviewId || providerReviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
    const look = await zGet(`/search.json?query=${q}`);
    if (!look.ok) {
      const t = await look.text();
      return res.status(400).send(`Zendesk lookup failed: ${look.status}\n${t}`);
    }
    const data = await look.json();
    let ticketId = data?.results?.[0]?.id || null;

    // custom fields
    const custom_fields = [
      { id: +ZD_FIELD_REVIEW_ID,  value: String(reviewId || providerReviewId || "") },
      { id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") },
      { id: +ZD_FIELD_RATING,     value: rating || 0 },
    ];
    if (ZD_FIELD_LOCATION_NAME && locationName) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    }

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", provider.toLowerCase(), `cmrvw_${reviewId || providerReviewId}`];

    if (!ticketId) {
      // create
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags: commonTags,
          custom_fields,
          comment: { body: note, public: false }
        }
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      ticketId = j?.ticket?.id;
      return res.status(200).json({ ok: true, action: "created", id: ticketId, provider, had_text: isNonEmptyString(comment) });
    } else {
      // update
      const payload = {
        ticket: {
          external_id,
          tags: commonTags,
          custom_fields,
          comment: { body: note, public: false }
        }
      };
      const r = await zSend(`/tickets/${ticketId}.json`, "PUT", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk update failed: ${r.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: ticketId, provider, had_text: isNonEmptyString(comment) });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

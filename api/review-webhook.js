// /api/review-webhook.js
// Create/update Zendesk ticket with ONE INTERNAL card.
// If incoming text is empty or token-ish, fetch Chatmeter review detail to extract real text.
// Stronger de-dupe: check external_id, tag, and custom field; use create_or_update.

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  looksLikeOpaqueId,
  normalizeProvider,
} from "./_helpers.js";

async function fetchReviewDetailSmart({ id, providerReviewId, chmBase, token, accountId }) {
  if (!token) return null;
  const headers = { Authorization: token };

  const paths = [
    `/reviews/${encodeURIComponent(String(id || providerReviewId || ""))}`,
    `/reviewBuilder/reviews/${encodeURIComponent(String(id || providerReviewId || ""))}`,
  ].filter(Boolean);

  for (const p of paths) {
    const url = `${chmBase}${p}${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      try { return JSON.parse(t); } catch { return {}; }
    } catch (_) {}
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
    ZD_FIELD_LOCATION_NAME,

    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID,
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING && "ZD_FIELD_RATING",
    !ZD_FIELD_FIRST_REPLY_SENT && "ZD_FIELD_FIRST_REPLY_SENT",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId       = body.id || body.reviewId || body.providerReviewId;
    const provider       = normalizeProvider(body.provider || body.contentProvider || "");
    const locationId     = body.locationId || "";
    const locationName   = body.locationName || "";
    const rating         = Number(body.rating || 0);
    const createdAt      = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName     = body.authorName || body.reviewerUserName || body.reviewer || "";
    const publicUrl      = body.publicUrl || body.reviewURL || body.portalUrl || "";

    let comment = isNonEmptyString(body.text) ? body.text.trim() : getProviderComment(provider, body);
    if (!isNonEmptyString(comment) || looksLikeOpaqueId(comment)) {
      const detail = await fetchReviewDetailSmart({
        id: body.id, providerReviewId: body.providerReviewId,
        chmBase: CHATMETER_V5_BASE, token: CHATMETER_V5_TOKEN, accountId: CHM_ACCOUNT_ID
      });
      if (detail && typeof detail === "object") {
        const fromDetail = getProviderComment(provider, detail);
        if (isNonEmptyString(fromDetail)) comment = fromDetail.trim();
        else {
          const raw = detail.reviewText || detail.text || detail.body || detail.comment || "";
          if (isNonEmptyString(raw) && !looksLikeOpaqueId(raw)) comment = raw.trim();
        }
      }
    }

    const external_id  = `chatmeter:${reviewId}`;
    const tagProvider  = provider ? provider.toLowerCase() : "chatmeter";
    const tagReview    = `cmrvw_${reviewId}`;

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

    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, {
      headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" }
    });
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });

    // ---- Stronger de-dupe lookups ----
    async function findExistingTicket() {
      // 1) by external_id
      const q1 = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
      for (const q of [q1]) {
        const r = await zGet(`/search.json?query=${q}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j?.results) && j.results.length) return j.results[0].id;
        }
      }
      // 2) by tag cmrvw_<id>
      const q2 = encodeURIComponent(`type:ticket tags:${tagReview}`);
      {
        const r = await zGet(`/search.json?query=${q2}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j?.results) && j.results.length) return j.results[0].id;
        }
      }
      // 3) by custom field (review id)
      const cfId = Number(ZD_FIELD_REVIEW_ID);
      if (cfId) {
        // Zendesk supports search on custom fields: custom_field_<id>:<value>
        const q3 = encodeURIComponent(`type:ticket custom_field_${cfId}:"${String(reviewId)}"`);
        const r = await zGet(`/search.json?query=${q3}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j?.results) && j.results.length) return j.results[0].id;
        }
      }
      return null;
    }

    let ticketId = await findExistingTicket();

    const baseCustoms = [];
    baseCustoms.push({ id: +ZD_FIELD_REVIEW_ID,   value: String(reviewId || "") });
    baseCustoms.push({ id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") });
    baseCustoms.push({ id: +ZD_FIELD_RATING,      value: rating || 0 });
    if (ZD_FIELD_LOCATION_NAME) baseCustoms.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName || "" });

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", tagProvider, tagReview];

    const payload = {
      ticket: {
        subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
        requester: { email: requesterEmail, name: requesterEmail },
        external_id,
        tags: commonTags,
        custom_fields: baseCustoms,
        comment: { body: note, public: false }
      }
    };

    // Use create_or_update: if external_id exists, Zendesk updates instead of creating a duplicate.
    const endpoint = ticketId ? `/tickets/${ticketId}.json` : `/tickets/create_or_update.json`;
    const method   = ticketId ? "PUT" : "POST";

    const rSave = await zSend(endpoint, method, payload);
    const tSave = await rSave.text();
    if (!rSave.ok) {
      return res.status(400).send(`Zendesk ${ticketId ? "update" : "create_or_update"} failed: ${rSave.status}\n${tSave}`);
    }

    // Normalize response
    let savedId = ticketId;
    try { savedId = JSON.parse(tSave)?.ticket?.id || ticketId; } catch {}
    return res.status(200).json({
      ok: true,
      action: ticketId ? "updated" : "create_or_update",
      id: savedId,
      externalId: external_id
    });

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

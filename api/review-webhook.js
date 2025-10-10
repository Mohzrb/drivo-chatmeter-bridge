// /api/review-webhook.js
// Chatmeter -> Zendesk: create/update ticket with ONE INTERNAL card.
// If incoming "text" is empty/boolean, fetch Chatmeter detail and
// run provider-specific extraction to get a proper comment.

import {
  VERSION_HELPERS,
  isNonEmptyString,
  isBooleanString,
  normalizeProvider,
  extractReviewData,
  buildInternalNote,
  safeJSON,
} from "./_helpers.js";

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
    CHM_ACCOUNT_ID = "",  // optional default
    CHM_LOCATION_MAP = "{}",
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING && "ZD_FIELD_RATING",
    !ZD_FIELD_FIRST_REPLY_SENT && "ZD_FIELD_FIRST_REPLY_SENT",
    !CHATMETER_V5_TOKEN && "CHATMETER_V5_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const locMap = safeJSON(CHM_LOCATION_MAP, {});
  const zendeskBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
  const auth = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
  const zGet  = (p) => fetch(`${zendeskBase}${p}`, { headers: { Authorization: auth, "Accept": "application/json" }});
  const zSend = (p, method, payload) => fetch(`${zendeskBase}${p}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  try {
    // ---- parse incoming webhook body
    const body = typeof req.body === "string" ? safeJSON(req.body, {}) : (req.body || {});
    const reviewId   = body.id || body.reviewId || body.providerReviewId || "";
    const provider   = normalizeProvider(body.provider || body.contentProvider || "");
    const locationId = String(body.locationId || "");
    const locationName = body.locationName || locMap[locationId] || "";
    const rating     = Number(body.rating || 0);
    const createdAt  = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName = body.authorName || body.reviewerUserName || body.reviewer || "Anonymous";
    const publicUrl  = body.publicUrl || body.reviewURL || body.portalUrl || "";

    if (!isNonEmptyString(reviewId)) {
      return res.status(400).send("Missing id (reviewId/providerReviewId)");
    }

    // ---- if text is missing or boolean-like => fetch detail from Chatmeter
    let detail = null;
    let text = isNonEmptyString(body.text) ? body.text.trim() : "";
    if (!text || isBooleanString(text)) {
      detail = await fetchReviewDetailSmart(reviewId, CHATMETER_V5_BASE, CHATMETER_V5_TOKEN, CHM_ACCOUNT_ID);
    }

    // Build provider-normalized bundle (uses detail if present)
    const normalized = extractReviewData(
      provider,
      body,
      detail || body,
      locMap
    );

    // Always ensure locationName shown (use env map if missing)
    if (!isNonEmptyString(normalized.locationName)) {
      normalized.locationName = locMap[normalized.locationId] || locationName || "Unknown";
    }

    const note = buildInternalNote({
      dt: normalized.createdAt || createdAt,
      customer: normalized.authorName || authorName,
      provider: normalized.provider || provider,
      locationName: normalized.locationName || locationName,
      locationId: normalized.locationId || locationId,
      rating: normalized.rating || rating,
      comment: normalized.comment || "(no text)",
      viewUrl: normalized.publicUrl || publicUrl,
    });

    // ---- de-dupe on external_id
    const external_id = `chatmeter:${reviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
    const sr = await zGet(`/search.json?query=${q}`);
    if (!sr.ok) {
      const t = await sr.text();
      return res.status(400).send(`Zendesk lookup failed: ${sr.status}\n${t}`);
    }
    const sj = await sr.json();
    const existingId = sj?.results?.[0]?.id || null;

    const customFields = [
      { id: +ZD_FIELD_REVIEW_ID,  value: String(reviewId) },
      { id: +ZD_FIELD_LOCATION_ID, value: String(normalized.locationId || locationId || "") },
      { id: +ZD_FIELD_RATING,     value: Number(normalized.rating || rating || 0) },
    ];
    if (ZD_FIELD_LOCATION_NAME) {
      customFields.push({ id: +ZD_FIELD_LOCATION_NAME, value: normalized.locationName || locationName || "" });
    }

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", normalized.provider?.toLowerCase() || "chatmeter", `cmrvw_${reviewId}`];

    if (!existingId) {
      // create
      const payload = {
        ticket: {
          subject: `${normalized.locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, normalized.rating || 0)))} – ${normalized.authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags: commonTags,
          custom_fields: customFields,
          comment: { body: note, public: false },
        }
      };
      const cr = await zSend("/tickets.json", "POST", payload);
      const t = await cr.text();
      if (!cr.ok) return res.status(400).send(`Zendesk create failed: ${cr.status}\n${t}`);
      const j = safeJSON(t, {});
      return res.status(200).json({ ok: true, action: "created", id: j?.ticket?.id, version: VERSION_HELPERS });
    } else {
      // update (append single INTERNAL card)
      const payload = {
        ticket: {
          external_id,
          tags: commonTags,
          custom_fields: customFields,
          comment: { body: note, public: false },
        }
      };
      const ur = await zSend(`/tickets/${existingId}.json`, "PUT", payload);
      const t = await ur.text();
      if (!ur.ok) return res.status(400).send(`Zendesk update failed: ${ur.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: existingId, version: VERSION_HELPERS });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------------- Chatmeter detail fetch ---------------- */
async function fetchReviewDetailSmart(id, chmBase, token, accountId) {
  if (!id || !token) return null;
  const headers = { Authorization: token };

  // primary endpoint
  const attempts = [
    `/reviews/${encodeURIComponent(String(id))}`,
    `/reviewBuilder/reviews/${encodeURIComponent(String(id))}`,
  ];

  for (const p of attempts) {
    const url = `${chmBase}${p}${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      const j = safeJSON(t, {});
      if (j && typeof j === "object") return j;
    } catch { /* next */ }
  }
  return null;
}

// /api/review-webhook.js
// Create/update Zendesk ticket with ONE INTERNAL card (formatted like your screenshot).
// If incoming text is empty/boolean, we fetch Chatmeter review detail to extract proper text.

import {
  getProviderComment, buildInternalNote, isNonEmptyString, normalizeProvider, pickCustomerContact
} from "./_helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN,
    ZD_FIELD_REVIEW_ID, ZD_FIELD_LOCATION_ID, ZD_FIELD_RATING,
    ZD_FIELD_FIRST_REPLY_SENT, ZD_FIELD_LOCATION_NAME,
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING && "ZD_FIELD_RATING"
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const inBody = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = inBody.id || inBody.reviewId || inBody.providerReviewId;
    const provider     = normalizeProvider(inBody.provider || inBody.contentProvider || "");
    const locationId   = String(inBody.locationId || "");
    const locationName = String(inBody.locationName || "");
    const rating       = Number(inBody.rating || 0);
    const createdAt    = inBody.createdAt || inBody.reviewDate || new Date().toISOString();
    const authorName   = inBody.authorName || inBody.reviewerUserName || inBody.reviewer || "";
    const publicUrl    = inBody.publicUrl || inBody.reviewURL || inBody.portalUrl || "";
    const contact      = pickCustomerContact(inBody);

    // comment text (fix for Yelp/Google missing text & ReviewBuilder booleans)
    let comment = isNonEmptyString(inBody.text) ? inBody.text.trim() : "";
    if (!comment || comment.toLowerCase() === "true" || comment.toLowerCase() === "false") {
      // Fetch detail from Chatmeter to extract text
      if (CHATMETER_V5_TOKEN && reviewId) {
        try {
          const detRes = await fetch(`${CHATMETER_V5_BASE}/reviews/${encodeURIComponent(reviewId)}`, {
            headers: { Authorization: CHATMETER_V5_TOKEN }
          });
          const raw = await detRes.text();
          const det = JSON.parse(raw);
          comment = getProviderComment(provider, det) || "";
          if (!comment && isNonEmptyString(det?.comment)) comment = det.comment.trim();
        } catch {}
      }
    }

    const external_id  = `chatmeter:${reviewId}`;
    const tagProvider  = provider ? provider.toLowerCase() : "chatmeter";
    const requesterEmail = "reviews@drivo.com";
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (p) => fetch(`${zBase}${p}`, { headers: { Authorization: auth, "Accept":"application/json" }});
    const zSend = (p, m, b) => fetch(`${zBase}${p}`, {
      method: m,
      headers: { Authorization: auth, "Content-Type":"application/json", "Accept":"application/json" },
      body: JSON.stringify(b)
    });

    // De-dupe by external_id
    let ticketId = null;
    {
      const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
      const r = await zGet(`/search.json?query=${q}`);
      if (!r.ok) return res.status(400).send(`Zendesk lookup failed: ${r.status} ${await r.text()}`);
      const d = await r.json();
      ticketId = d?.results?.[0]?.id || null;
    }

    const customs = [
      { id: +ZD_FIELD_REVIEW_ID,  value: String(reviewId || "") },
      { id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") },
      { id: +ZD_FIELD_RATING,     value: rating || 0 },
    ];
    if (ZD_FIELD_LOCATION_NAME) customs.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName || "" });

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
      viewUrl: publicUrl
    });

    const tags = ["chatmeter", tagProvider, `cmrvw_${reviewId}`];

    if (!ticketId) {
      // create
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags,
          custom_fields: customs,
          comment: { body: note, public: false }
        }
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      return res.status(200).json({ ok: true, action: "created", id: j?.ticket?.id, externalId: external_id });
    } else {
      // update (append single INTERNAL card)
      const payload = {
        ticket: {
          external_id,
          tags,
          custom_fields: customs,
          comment: { body: note, public: false }
        }
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

// /api/review-webhook.js
// Chatmeter -> Zendesk: create/update ticket with single INTERNAL card

import { getProviderComment, buildInternalNote, isNonEmptyString } from "./_helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID  = process.env.ZD_FIELD_REVIEW_ID;       // text
  const F_LOCATIONID = process.env.ZD_FIELD_LOCATION_ID;     // number/text
  const F_RATING     = process.env.ZD_FIELD_RATING;          // number
  const F_FIRST      = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const F_LOCNAME    = process.env.ZD_FIELD_LOCATION_NAME;   // optional text/tagger

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
    !F_REVIEW_ID  && "ZD_FIELD_REVIEW_ID",
    !F_LOCATIONID && "ZD_FIELD_LOCATION_ID",
    !F_RATING     && "ZD_FIELD_RATING",
    !F_FIRST      && "ZD_FIELD_FIRST_REPLY_SENT",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId || body.providerReviewId;
    const provider     = (body.provider || body.contentProvider || "").toUpperCase();
    const locationId   = body.locationId || "";
    const locationName = body.locationName || "";
    const rating       = Number(body.rating || 0);
    const createdAt    = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName   = body.authorName || body.reviewerUserName || body.reviewer || "";
    const publicUrl    = body.publicUrl || body.reviewURL || body.portalUrl || "";

    const comment = isNonEmptyString(body.text)
      ? body.text.trim()
      : getProviderComment(provider, body);

    const external_id  = `chatmeter:${reviewId}`;
    const tagProvider  = provider ? provider.toLowerCase() : "chatmeter";

    // Build INTERNAL note
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

    // Zendesk HTTP helpers
    const zBase = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, { headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" }});
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });

    // 1) de-dupe by external_id
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

    const baseCustoms = [];
    baseCustoms.push({ id: +F_REVIEW_ID,  value: String(reviewId || "") });
    baseCustoms.push({ id: +F_LOCATIONID, value: String(locationId || "") });
    baseCustoms.push({ id: +F_RATING,     value: rating || 0 });
    if (F_LOCNAME) baseCustoms.push({ id: +F_LOCNAME, value: locationName || "" });

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", tagProvider, `cmrvw_${reviewId}`];

    if (!ticketId) {
      // 2) create new ticket
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags: commonTags,
          custom_fields: baseCustoms,
          comment: {
            body: note,
            public: false
          }
        }
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      ticketId = j?.ticket?.id;
      return res.status(200).json({ ok: true, action: "created", id: ticketId, externalId: external_id });
    } else {
      // 3) update existing ticket (append single INTERNAL card, do not duplicate)
      const payload = {
        ticket: {
          external_id,
          tags: commonTags,
          custom_fields: baseCustoms,
          comment: {
            body: note,
            public: false
          }
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

// /api/review-webhook.js
// Chatmeter -> Zendesk: create/update ticket with ONE INTERNAL card (idempotent)
// If the incoming comment is empty/boolean, we still extract proper text via helpers.
// We stamp each posted note with a hidden marker and skip re-posting duplicates.

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  normalizeProvider
} from "./_helpers.js";

/* ---------------- idempotent note helpers ---------------- */

function hashNote(s) {
  // djb2 (XOR variant) -> base36
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function withMarker(note, reviewId) {
  const h = hashNote(note);
  const marker = `cmrvw:${reviewId}:${h}`;
  const marked = `${note}\n\n<!-- ${marker} -->`;
  return { marked, marker };
}

async function noteAlreadyPosted({ zBase, auth, ticketId, marker }) {
  // Look at recent audits for the unique marker we append to the note body.
  // If found, we won't post the same note again.
  const url = `${zBase}/tickets/${ticketId}/audits.json?sort_order=desc&page=1&per_page=30`;
  const r = await fetch(url, {
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!r.ok) return false;
  const j = await r.json();
  if (!Array.isArray(j?.audits)) return false;

  for (const a of j.audits) {
    if (!Array.isArray(a?.events)) continue;
    for (const e of a.events) {
      if (typeof e?.body === "string" && e.body.includes(marker)) return true;
    }
  }
  return false;
}

/* ---------------- main handler ---------------- */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const F_REVIEW_ID  = process.env.ZD_FIELD_REVIEW_ID;         // text
  const F_LOCATIONID = process.env.ZD_FIELD_LOCATION_ID;       // number/text
  const F_RATING     = process.env.ZD_FIELD_RATING;            // number
  const F_FIRST      = process.env.ZD_FIELD_FIRST_REPLY_SENT;  // checkbox
  const F_LOCNAME    = process.env.ZD_FIELD_LOCATION_NAME;     // optional

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

    // Normalize inbound payload
    const reviewId     = body.id || body.reviewId || body.providerReviewId;
    if (!reviewId) return res.status(400).send("Missing id");
    const provider     = normalizeProvider((body.provider || body.contentProvider || "").toString());
    const locationId   = body.locationId || "";
    const locationName = body.locationName || "";
    const rating       = Number(body.rating || 0);
    const createdAt    = body.createdAt || body.reviewDate || new Date().toISOString();
    const authorName   = body.authorName || body.reviewerUserName || body.reviewer || "";
    const publicUrl    = body.publicUrl || body.reviewURL || body.portalUrl || "";

    const text = isNonEmptyString(body.text)
      ? body.text.trim()
      : getProviderComment(provider, body);

    const external_id = `chatmeter:${reviewId}`;
    const tagProvider = provider ? provider.toLowerCase() : "chatmeter";

    // Compose INTERNAL note (then wrap with idempotent marker)
    const rawNote = buildInternalNote({
      dt: createdAt,
      customer: authorName,
      provider,
      locationName,
      locationId,
      rating,
      comment: text,
      viewUrl: publicUrl,
    });
    const { marked: note, marker } = withMarker(rawNote, reviewId);

    // Zendesk HTTP helpers
    const zBase = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, {
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }
    });
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    // 1) de-dupe BY TICKET using external_id
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

    // Common fields/tags for either create or update
    const baseCustoms = [];
    baseCustoms.push({ id: +F_REVIEW_ID,  value: String(reviewId || "") });
    baseCustoms.push({ id: +F_LOCATIONID, value: String(locationId || "") });
    baseCustoms.push({ id: +F_RATING,     value: rating || 0 });
    if (F_LOCNAME) baseCustoms.push({ id: +F_LOCNAME, value: locationName || "" });

    const requesterEmail = "reviews@drivo.com";
    const commonTags = ["chatmeter", tagProvider, `cmrvw_${reviewId}`];

    // 2) CREATE if no ticket exists
    if (!ticketId) {
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
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      ticketId = j?.ticket?.id;
      return res.status(200).json({ ok: true, action: "created", id: ticketId, externalId: external_id });
    }

    // 3) UPDATE existing ticket
    // Check if we've already posted this exact note; if so, skip re-posting it.
    let shouldPostComment = true;
    try {
      const exists = await noteAlreadyPosted({ zBase, auth, ticketId, marker });
      if (exists) shouldPostComment = false;
    } catch {
      // If audits read fails, treat as not found (we’ll post)
      shouldPostComment = true;
    }

    const updatePayload = {
      ticket: {
        external_id,
        tags: commonTags,
        custom_fields: baseCustoms,
        ...(shouldPostComment ? { comment: { body: note, public: false } } : {})
      }
    };

    const rU = await zSend(`/tickets/${ticketId}.json`, "PUT", updatePayload);
    const tU = await rU.text();
    if (!rU.ok) return res.status(400).send(`Zendesk update failed: ${rU.status}\n${tU}`);

    return res.status(200).json({
      ok: true,
      action: shouldPostComment ? "updated_with_note" : "updated_no_duplicate_note",
      id: ticketId,
      externalId: external_id
    });

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

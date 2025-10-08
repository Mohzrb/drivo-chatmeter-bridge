// /api/review-webhook.js
// Chatmeter → Zendesk (create ticket with INTERNAL "Review Information" note)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ---- env (Zendesk)
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;      // e.g. drivohelp
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;          // agent/admin
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  // ---- env (custom field IDs)
  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text/number
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // number
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // (optional) text/tagger

  // ---- optional JSON map: {"1001892551":"JFK","1001892552":"LGA", ...}
  let LOCATION_MAP = {};
  try { LOCATION_MAP = JSON.parse(process.env.CHM_LOCATION_MAP || "{}"); } catch {}

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // ---- helpers
  const zdAuth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const zurl   = (p) => `https://${ZD_SUBDOMAIN}.zendesk.com${p}`;

  const safe = (v, fb="") => (v === undefined || v === null ? fb : v);

  // Extract text from many providers reliably
  function extractText(r) {
    const b = r || {};
    // direct
    if (b.text) return String(b.text);
    if (b.comment) return String(b.comment);
    if (b.reviewText) return String(b.reviewText);
    if (b.body) return String(b.body);
    // provider-specific payloads (reviewData array etc.)
    if (Array.isArray(b.reviewData)) {
      // look for a field containing free text
      const keys = ["np_review_text", "np_respondable_text", "comment", "text", "body", "message"];
      for (const k of keys) {
        const f = b.reviewData.find((x) =>
          x?.name?.toLowerCase() === k || x?.label?.toLowerCase() === k
        );
        if (f?.value) return String(f.value);
      }
    }
    return "";
  }

  // pretty block
  function buildInternalNote(payload) {
    const {
      id, provider, locationId, locationName, rating,
      authorName, authorEmail, authorPhone, createdAt, text, publicUrl
    } = payload;

    const when = safe(createdAt);
    const locCode = safe(LOCATION_MAP[locationId], locationName || locationId || "Unknown");
    const lines = [
      "Review Information:",
      "",
      when ? `Date: ${when}` : null,
      (authorName || authorEmail || authorPhone)
        ? [
            authorName ? `Customer: ${authorName}` : null,
            authorEmail ? authorEmail : null,
            authorPhone ? authorPhone : null
          ].filter(Boolean).join("\n") : null,
      `Location: ${locCode}${locationId ? ` (${locationId})` : ""}`,
      `Provider: ${provider || "Unknown"}`,
      `Rating: ${rating ? `${rating}★` : "N/A"}`,
      "",
      "Review Text:",
      text || "(no text)",
      "",
      publicUrl ? `Public URL:\n${publicUrl}` : null
    ].filter(Boolean);

    return lines.join("\n");
  }

  // ---- read inbound body
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = safe(body.id || body.reviewId || body.review_id, "").toString();
    if (!reviewId) return res.status(400).send("Missing reviewId/id");

    const provider     = safe(body.provider || body.contentProvider, "REVIEW");
    const locationId   = safe(body.locationId, "");
    const rating       = Number(safe(body.rating, 0));
    const authorName   = safe(body.authorName || body.reviewerUserName || "Reviewer");
    const authorEmail  = safe(body.authorEmail, "");
    const authorPhone  = safe(body.authorPhone, "");
    const createdAt    = safe(body.createdAt || body.reviewDate || body.date, "");
    const text         = extractText(body);
    const publicUrl    = safe(body.publicUrl || body.reviewURL || body.url, "");
    const locName      = LOCATION_MAP[locationId] || safe(body.locationName, "");

    const subject = `${locName || locationId || "Location"} – ${rating || "?"}★ – ${authorName}`;
    const requesterEmail = "reviews@drivo.com";

    // DEDUPE: 1) by external_id, 2) by tag
    const extId = `chatmeter:${reviewId}`;
    const tagId = `cmrvw_${reviewId}`;
    const q1 = encodeURIComponent(`type:ticket external_id:"${extId}"`);
    const q2 = encodeURIComponent(`type:ticket tags:${tagId}`);
    const search1 = await fetch(zurl(`/api/v2/search.json?query=${q1}`), { headers: { Authorization: zdAuth }});
    const s1 = await search1.json();
    if (Array.isArray(s1.results) && s1.results.length) {
      return res.status(200).json({ ok: true, deduped: true, ticketId: s1.results[0].id, via: "external_id" });
    }
    const search2 = await fetch(zurl(`/api/v2/search.json?query=${q2}`), { headers: { Authorization: zdAuth }});
    const s2 = await search2.json();
    if (Array.isArray(s2.results) && s2.results.length) {
      return res.status(200).json({ ok: true, deduped: true, ticketId: s2.results[0].id, via: "tag" });
    }

    // Build INTERNAL note body
    const note = buildInternalNote({
      id: reviewId, provider, locationId, locationName: locName,
      rating, authorName, authorEmail, authorPhone, createdAt, text, publicUrl
    });

    // custom fields
    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId) });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locName) custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: String(locName) });

    const ticket = {
      ticket: {
        subject,
        requester: { name: "Chatmeter", email: requesterEmail },
        external_id: extId,
        tags: ["review", (provider || "chatmeter").toLowerCase(), tagId, "chatmeter"],
        comment: { body: note, public: false },  // INTERNAL first message
        custom_fields
      }
    };

    const create = await fetch(zurl("/api/v2/tickets.json"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: zdAuth },
      body: JSON.stringify(ticket)
    });

    const raw = await create.text();
    if (!create.ok) return res.status(502).send(`Zendesk create failed: ${create.status} ${raw}`);

    const data = JSON.parse(raw);
    return res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null, external_id: extId, tag: tagId });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

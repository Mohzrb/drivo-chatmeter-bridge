// File: api/review-webhook.js
// Chatmeter → Zendesk (UPSERT with external_id = reviewId)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Zendesk creds
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;   // e.g., drivohelp
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  // Optional custom field IDs (numbers in Zendesk)
  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // text
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // text
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // text or dropdown (tags must match)
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // numeric
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL     && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  // Parse payload
  const body = typeof req.body === "string" ? safeParse(req.body, {}) : (req.body || {});
  const reviewId     = str(body.id || body.reviewId || body.review_id);
  if (!reviewId) return res.status(400).send("Missing reviewId/id");

  const locationId   = str(body.locationId   ?? "");
  const locationName = str(body.locationName ?? "Unknown");
  const rating       = body.rating ?? 0;
  const authorName   = str(body.authorName   ?? "Chatmeter Reviewer");
  const createdAt    = str(body.createdAt    ?? "");
  const text         = str(body.text         ?? "");
  const publicUrl    = str(body.publicUrl    ?? "");
  const portalUrl    = str(body.portalUrl    ?? "");

  // Compose ticket subject/body
  const subject = `${locationName} – ${rating}★ – ${authorName}`.trim();
  const descriptionLines = [
    `Review ID: ${reviewId}`,
    `Location: ${locationName} (${locationId})`,
    `Rating: ${rating}★`,
    createdAt ? `Date: ${createdAt}` : "",
    "",
    "Review Text:",
    text || "(no text)",
    "",
    "Links:",
    publicUrl ? `Public URL: ${publicUrl}` : "",
    portalUrl ? `Chatmeter URL: ${portalUrl}` : "",
  ].filter(Boolean);
  const description = descriptionLines.join("\n");

  // Build custom fields
  const custom_fields = [];
  if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: reviewId });
  if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: locationId });
  if (ZD_FIELD_LOCATION_NAME)    custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME,    value: locationName });
  if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
  if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });

  // Auth header
  const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

  try {
    // 1) Try to find an existing ticket by external_id = reviewId
    const q = encodeURIComponent(`type:ticket external_id:${reviewId}`);
    const searchUrl = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=${q}`;
    const searchRes = await fetch(searchUrl, { headers: { Authorization: auth } });
    if (!searchRes.ok) {
      const t = await searchRes.text();
      return res.status(502).send(`Zendesk search error: ${searchRes.status} ${t}`);
    }
    const searchJson = await searchRes.json();
    const existing = Array.isArray(searchJson?.results) ? searchJson.results.find(r => r.external_id === reviewId) : null;

    if (existing) {
      // 2) UPDATE existing ticket (add private note + refresh fields/tags/subject)
      const ticketId = existing.id;
      const updateUrl = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;
      const updateBody = {
        ticket: {
          subject,
          comment: { body: `Update from Chatmeter bridge\n\n${description}`, public: false },
          custom_fields,
          tags: mergeTags(existing, ["chatmeter","review","inbound", `loc_${slug(locationName)}`]),
        }
      };
      const updRes = await fetch(updateUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(updateBody),
      });
      if (!updRes.ok) {
        const et = await updRes.text();
        return res.status(502).send(`Zendesk update error: ${updRes.status} ${et}`);
      }
      const updJson = await updRes.json();
      return res.status(200).json({
        ok: true,
        mode: "updated",
        ticketId,
        external_id: reviewId,
      });
    } else {
      // 3) CREATE new ticket with external_id set
      const createUrl = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;
      const createBody = {
        ticket: {
          external_id: reviewId, // <-- the dedup anchor
          subject,
          comment: { body: description, public: true },
          requester: { name: authorName, email: "reviews@drivo.com" },
          custom_fields,
          tags: ["chatmeter","review","inbound", `loc_${slug(locationName)}`],
        }
      };
      const crRes = await fetch(createUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(createBody),
      });
      if (!crRes.ok) {
        const et = await crRes.text();
        return res.status(502).send(`Zendesk create error: ${crRes.status} ${et}`);
      }
      const crJson = await crRes.json();
      return res.status(200).json({
        ok: true,
        mode: "created",
        createdTicketId: crJson?.ticket?.id ?? null,
        external_id: reviewId,
      });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------------- helpers ---------------- */

function str(x) { return (x == null ? "" : String(x)); }

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 40) || "unknown";
}

function mergeTags(existingTicket, add) {
  const ex = (existingTicket?.tags || []).map(String);
  const plus = (add || []).map(String);
  return Array.from(new Set([...ex, ...plus]));
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

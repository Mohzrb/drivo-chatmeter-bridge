// /api/review-webhook.js  — Chatmeter/Yelp/Google/… → Zendesk (idempotent, no duplicate notes)
import crypto from "crypto";

const ZD = {
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  token: process.env.ZENDESK_API_TOKEN,
  brandId: process.env.ZENDESK_BRAND_ID || null,
  groupId: process.env.ZENDESK_GROUP_ID || null,
  assigneeId: process.env.ZENDESK_ASSIGNEE_ID || null,
  cfReviewId: process.env.CUSTOM_FIELD_REVIEW_ID,      // e.g., "custom_field_123"
  cfNoteHash: process.env.CUSTOM_FIELD_NOTE_HASH,      // e.g., "custom_field_456"
};

function zdAuthHeader() {
  const basic = Buffer.from(`${ZD.email}/token:${ZD.token}`).toString("base64");
  return { Authorization: `Basic ${basic}`, "Content-Type": "application/json" };
}

function hashText(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

// Normalize provider payloads → one shape
function normalizeReview(body) {
  // Accepts Chatmeter “review” or a direct provider payload.
  const r = body.review || body; // support both shapes

  const platform = (r.platform || r.source || r.provider || "").toLowerCase(); // e.g. yelp, google
  const reviewId = String(r.id || r.reviewId || r.externalId || r.sourceId || r.uuid || "").trim();

  // Text fields differ by provider; try the common ones in order:
  const text =
    r.text?.trim() ||
    r.comment?.trim() ||
    r.content?.trim() ||
    r.reviewText?.trim() ||
    r.body?.trim() ||
    r.snippet?.trim() ||
    ""; // some Yelp ratings have no text at all

  const rating = Number(r.rating ?? r.stars ?? r.score ?? 0) || 0;
  const author =
    r.author?.name ||
    r.user?.name ||
    r.reviewer?.name ||
    r.authorName ||
    r.userName ||
    "Anonymous";
  const permalink =
    r.url || r.link || r.permalink || r.shareUrl || r.reviewUrl || null;

  const locationName =
    r.location?.name || r.businessName || r.locationName || r.store || null;

  const createdAt =
    r.createdAt || r.created_at || r.timeCreated || r.date || new Date().toISOString();

  // Build a stable cross-platform key
  const platformKey = platform || "unknown";
  const uniqueKey = `${platformKey}:${reviewId || hashText(`${platformKey}:${author}:${createdAt}:${text}`)}`;

  return {
    uniqueKey,           // for Zendesk external_id
    platform: platformKey,
    reviewId: reviewId || null,
    rating,
    text,
    author,
    permalink,
    locationName,
    createdAt,
    raw: r,
  };
}

async function zdSearchByExternalId(external_id) {
  const url = `https://${ZD.subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(`type:ticket external_id:"${external_id}"`)}`;
  const res = await fetch(url, { headers: zdAuthHeader() });
  if (!res.ok) throw new Error(`Zendesk search failed: ${res.status}`);
  const data = await res.json();
  return (data.results || [])[0] || null;
}

async function zdGetTicket(ticketId) {
  const url = `https://${ZD.subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const res = await fetch(url, { headers: zdAuthHeader() });
  if (!res.ok) throw new Error(`Zendesk get ticket failed: ${res.status}`);
  const data = await res.json();
  return data.ticket;
}

async function zdCreateTicket(payload, idemKey) {
  const url = `https://${ZD.subdomain}.zendesk.com/api/v2/tickets.json`;
  const headers = { ...zdAuthHeader(), "Idempotency-Key": idemKey };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ticket: payload }) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Zendesk create failed: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.ticket;
}

async function zdUpdateTicket(ticketId, payload, idemKey) {
  const url = `https://${ZD.subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const headers = { ...zdAuthHeader(), "Idempotency-Key": idemKey };
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ ticket: payload }) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Zendesk update failed: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.ticket;
}

function buildTicketFields(n) {
  const fields = [];
  if (ZD.cfReviewId)  fields.push({ id: ZD.cfReviewId,  value: n.reviewId || n.uniqueKey });
  // we set cfNoteHash separately when we actually add a note
  return fields;
}

function buildSubject(n) {
  const loc = n.locationName ? ` @ ${n.locationName}` : "";
  return `[${n.platform.toUpperCase()} ${n.rating}★] ${n.author}${loc}`;
}

function buildDescription(n) {
  const text = n.text || "(No review text)";
  const link = n.permalink ? `\n\nLink: ${n.permalink}` : "";
  return `${text}${link}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const n = normalizeReview(req.body);

    // 1) Upsert by external_id
    const existing = await zdSearchByExternalId(n.uniqueKey);

    const baseTicket = {
      subject: buildSubject(n),
      external_id: n.uniqueKey,
      brand_id: ZD.brandId ? Number(ZD.brandId) : undefined,
      group_id: ZD.groupId ? Number(ZD.groupId) : undefined,
      assignee_id: ZD.assigneeId ? Number(ZD.assigneeId) : undefined,
      tags: ["chatmeter", n.platform, `rating_${n.rating}`],
      custom_fields: buildTicketFields(n),
    };

    let ticket;
    if (!existing) {
      // Create ticket with public description (initial body)
      const createPayload = {
        ...baseTicket,
        comment: {
          public: true,
          body: buildDescription(n),
        },
      };
      ticket = await zdCreateTicket(createPayload, `create:${n.uniqueKey}`);
    } else {
      // Update minimal metadata (don’t add duplicate notes here)
      ticket = await zdUpdateTicket(existing.id, baseTicket, `update:${n.uniqueKey}`);
    }

    // 2) Internal note de-duplication
    // Compose an internal note (e.g., structured payload details)
    const internalNote = [
      `Platform: ${n.platform}`,
      `Author: ${n.author}`,
      `Rating: ${n.rating}★`,
      `Created: ${n.createdAt}`,
      n.permalink ? `Permalink: ${n.permalink}` : null,
      n.text ? `\n"${n.text}"` : null,
    ].filter(Boolean).join("\n");

    const noteHash = hashText(internalNote);
    const freshTicket = await zdGetTicket(ticket.id);
    const fields = Object.fromEntries((freshTicket.custom_fields || []).map(f => [String(f.id), f.value]));

    const prevHash = ZD.cfNoteHash ? fields[ZD.cfNoteHash] : null;
    if (ZD.cfNoteHash && prevHash === noteHash) {
      // Note already posted — skip
      return res.status(200).json({ ok: true, ticket_id: ticket.id, action: "skipped_duplicate_note" });
    }

    // Post internal note once (idempotent)
    const updatePayload = {
      custom_fields: [
        ...((freshTicket.custom_fields || []).filter(f => String(f.id) !== String(ZD.cfNoteHash))),
        { id: ZD.cfNoteHash, value: noteHash },
      ],
      comment: { public: false, body: internalNote },
    };

    await zdUpdateTicket(ticket.id, updatePayload, `note:${n.uniqueKey}:${noteHash}`);

    res.status(200).json({ ok: true, ticket_id: ticket.id, action: existing ? "updated+noted" : "created+noted" });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

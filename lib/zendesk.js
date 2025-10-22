// lib/zendesk.js
// Minimal, correct Zendesk v2 client:
// - Search ticket by external_id
// - Create ticket if missing (private initial comment)
// - Add internal note via PUT /api/v2/tickets/{id}.json
// - Read audits to de-dupe comments

function reqHeaders() {
  const sub = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN;
  if (!sub || !email || !apiToken) {
    throw new Error("Missing Zendesk env: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN");
  }
  const basic = Buffer.from(`${email}/token:${apiToken}`).toString("base64");
  return {
    base: `https://${sub}.zendesk.com/api/v2`,
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
}

async function zdFetch(path, init = {}) {
  const { base, headers } = reqHeaders();
  const url = `${base}${path}`;
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const preview = text?.slice(0, 500) || "";
    throw new Error(`Zendesk ${init.method || "GET"} ${path} -> ${res.status}: ${preview}`);
  }
  return json;
}

// ---------- Public helpers ----------

/**
 * Find or create a ticket keyed by external_id (review.id).
 * Returns { id }.
 */
export async function findOrCreateTicketByExternalId(review) {
  const externalId = String(review.id || review.reviewId || "").trim();
  if (!externalId) throw new Error("findOrCreateTicketByExternalId: missing review.id");

  // 1) search by external_id
  const q = `type:ticket external_id:${externalId}`;
  const search = await zdFetch(`/search.json?query=${encodeURIComponent(q)}`);
  const hit = (search?.results || []).find(r => r && r.id);
  if (hit) return { id: hit.id };

  // 2) create ticket
  const subject = `[Review] ${review.source || "chatmeter"} ${review.rating ?? ""}★ ${review.locationId ?? ""}`.trim();
  const body = [
    `Provider: ${review.source || "chatmeter"}`,
    review.rating != null ? `Rating: ${review.rating}` : null,
    review.url ? `URL: ${review.url}` : null,
    review.author ? `Author: ${review.author}` : null,
    review.createdAt ? `Date: ${review.createdAt}` : null,
    "",
    review.content || "(no text)"
  ].filter(Boolean).join("\n");

  const payload = {
    ticket: {
      subject,
      external_id: externalId,
      tags: ["chatmeter", "review", (review.source || "unknown").toString().toLowerCase()],
      // Private initial note
      comment: { body, public: false },
      // Optional: set requester to your integration user to avoid end-user tickets
      requester: { name: "Chatmeter Bridge", email: process.env.ZENDESK_EMAIL },
      priority: "normal"
    }
  };

  const created = await zdFetch(`/tickets.json`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const id = created?.ticket?.id;
  if (!id) throw new Error(`Zendesk create returned no ticket.id: ${JSON.stringify(created).slice(0, 400)}`);
  return { id };
}

/**
 * Add an internal (private) note to a ticket.
 */
export async function addInternalNote(ticketId, body) {
  if (!ticketId) throw new Error("addInternalNote: missing ticketId");
  const payload = { ticket: { comment: { body, public: false } } };
  await zdFetch(`/tickets/${encodeURIComponent(ticketId)}.json`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  return true;
}

/**
 * Get ticket audits for de-duplication.
 */
export async function getTicketAudits(ticketId) {
  if (!ticketId) throw new Error("getTicketAudits: missing ticketId");
  const audits = await zdFetch(`/tickets/${encodeURIComponent(ticketId)}/audits.json`);
  return audits?.audits || [];
}

/**
 * Zendesk helper functions — create, update, and find tickets.
 */

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function zdBase() {
  const sub = ensureEnv("ZENDESK_SUBDOMAIN");
  return `https://${sub}.zendesk.com/api/v2`;
}

function zdAuthHeader() {
  const email = ensureEnv("ZENDESK_EMAIL");
  const token = ensureEnv("ZENDESK_API_TOKEN");
  const basic = Buffer.from(`${email}/token:${token}`).toString("base64");
  return { Authorization: `Basic ${basic}` };
}

/** Helper for GET requests */
async function zdGet(path) {
  const r = await fetch(`${zdBase()}${path}`, {
    headers: { ...zdAuthHeader(), Accept: "application/json" }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Zendesk GET ${path} -> ${r.status}: ${text}`);
  }
  return r.json();
}

/** Helper for POST requests */
async function zdPost(path, body) {
  const r = await fetch(`${zdBase()}${path}`, {
    method: "POST",
    headers: {
      ...zdAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Zendesk POST ${path} -> ${r.status}: ${text}`);
  }
  return r.json();
}

/** 🔍 Find a ticket by external_id */
export async function findTicketByExternalId(external_id) {
  const data = await zdGet(`/search.json?query=type:ticket external_id:${encodeURIComponent(external_id)}`);
  const hits = Array.isArray(data?.results) ? data.results : [];
  const ticket = hits.find(h => h && h.external_id === external_id);
  return ticket || null;
}

/** 🆕 Create a new ticket for a Chatmeter review */
export async function createTicketForReview(review) {
  const subject = `[${review.source.toUpperCase()}] ${review.locationName} — ${review.authorName} (${review.rating}★)`;
  const descriptionLines = [
    `Source: ${review.source}`,
    `Rating: ${review.rating} / 5`,
    `Author: ${review.authorName}`,
    `Location: ${review.locationName}`,
    `Created: ${review.createdAt}`,
    review.url ? `URL: ${review.url}` : null,
    "",
    review.content || "(no text)"
  ].filter(Boolean);
  const description = descriptionLines.join("\n");

  const custom_fields = [];
  if (process.env.ZD_FIELD_REVIEW_ID)
    custom_fields.push({ id: Number(process.env.ZD_FIELD_REVIEW_ID), value: review.id });
  if (process.env.ZD_FIELD_LOCATION_ID && review.locationName)
    custom_fields.push({ id: Number(process.env.ZD_FIELD_LOCATION_ID), value: review.locationName });
  if (process.env.ZD_FIELD_RATING)
    custom_fields.push({ id: Number(process.env.ZD_FIELD_RATING), value: review.rating });

  const requester = { name: review.authorName || "Chatmeter Reviewer" };
  const external_id = `chatmeter:${review.id}`;

  const payload = {
    ticket: {
      subject,
      comment: { body: description, public: false },
      external_id,
      tags: ["chatmeter", review.source || "other"],
      requester,
      custom_fields
    }
  };
  if (process.env.ZD_AGENT_ID)
    payload.ticket.assignee_id = Number(process.env.ZD_AGENT_ID);

  const data = await zdPost("/tickets.json", payload);
  const id = data?.ticket?.id;
  if (!id) throw new Error("Ticket creation returned no id");
  return { id, created: true };
}

/** 📝 Add an internal note to an existing ticket */
export async function addInternalNote(ticketId, body) {
  const payload = { ticket: { comment: { body, public: false } } };
  await zdPost(`/tickets/${ticketId}.json`, payload);
}

/** 📜 Read audits for a ticket (for de-duplication) */
export async function getTicketAudits(ticketId) {
  const data = await zdGet(`/tickets/${ticketId}/audits.json`);
  return Array.isArray(data?.audits) ? data.audits : [];
}

/** 🧩 Find or create ticket by external id */
export async function findOrCreateTicketByExternalId(review) {
  const external_id = `chatmeter:${review.id}`;
  const existing = await findTicketByExternalId(external_id);
  if (existing) return { id: existing.id, created: false };
  return createTicketForReview(review);
}

/** 👤 Who am I (Zendesk) */
export async function whoami() {
  const me = await zdGet("/users/me.json");
  return { id: me?.user?.id, name: me?.user?.name, email: me?.user?.email };
}

// api/_zd.js
// Zendesk helper with idempotent create-or-update by external_id = chatmeter:<reviewId>
// Uses your env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN (or ZD_TOKEN)

const axios = require("axios");

const SUB = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const TOKEN = process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN; // support either name

if (!SUB) console.warn("[_zd] Missing ZENDESK_SUBDOMAIN");
if (!EMAIL) console.warn("[_zd] Missing ZENDESK_EMAIL");
if (!TOKEN) console.warn("[_zd] Missing ZENDESK_API_TOKEN / ZD_TOKEN");

const ZD_BASE = `https://${SUB}.zendesk.com/api/v2`;
const AUTH = "Basic " + Buffer.from(`${EMAIL}/token:${TOKEN || ""}`).toString("base64");

function ensureZendeskEnv() {
  if (!SUB || !EMAIL || !TOKEN) {
    const err = new Error("Missing Zendesk env vars (need ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN or ZD_TOKEN)");
    err.code = "NO_ZENDESK_ENV";
    throw err;
  }
}

async function findByExternalId(externalId) {
  ensureZendeskEnv();
  const q = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
  const { data } = await axios.get(`${ZD_BASE}/search.json?query=${q}`, {
    headers: { Authorization: AUTH },
  });
  return data.count > 0 ? data.results[0] : null;
}

async function createOrUpdateFromChatmeter({
  reviewId,
  subject,
  body,
  requester = "reviews@drivo.com",
  tags = ["chatmeter", "review", "google"],
  customFields = [], // array of {id, value}
}) {
  ensureZendeskEnv();
  if (!reviewId) throw new Error("Missing reviewId");

  const externalId = `chatmeter:${reviewId}`;
  const tagId = `cmrvw_${reviewId}`;
  const allTags = Array.from(new Set([...tags, tagId]));
  const headers = { Authorization: AUTH, "Content-Type": "application/json" };

  // 1) Try to find existing ticket
  const existing = await findByExternalId(externalId);
  if (existing) {
    await axios.put(
      `${ZD_BASE}/tickets/${existing.id}.json`,
      { ticket: { comment: { body, public: true }, tags: allTags } },
      { headers }
    );
    return { action: "updated", id: existing.id, externalId };
  }

  // 2) Create once, with external_id set
  const ticket = {
    subject,
    external_id: externalId,
    requester: { email: requester },
    comment: { body, public: true },
    tags: allTags,
  };

  if (customFields && customFields.length) {
    ticket.custom_fields = customFields.map(cf => ({ id: Number(cf.id), value: cf.value }));
  }

  const { data } = await axios.post(`${ZD_BASE}/tickets.json`, { ticket }, { headers });
  return { action: "created", id: data.ticket.id, externalId };
}

module.exports = { createOrUpdateFromChatmeter, findByExternalId };

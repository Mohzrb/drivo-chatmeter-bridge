// api/_zd.js
const axios = require("axios");

const SUB   = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const TOKEN = process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN;

if (!SUB)   console.warn("[_zd] Missing ZENDESK_SUBDOMAIN");
if (!EMAIL) console.warn("[_zd] Missing ZENDESK_EMAIL");
if (!TOKEN) console.warn("[_zd] Missing ZENDESK_API_TOKEN / ZD_TOKEN");

const ZD_BASE = `https://${SUB}.zendesk.com/api/v2`;
const AUTH    = "Basic " + Buffer.from(`${EMAIL}/token:${TOKEN || ""}`).toString("base64");
const ZH      = { Authorization: AUTH, "Content-Type": "application/json" };

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
  const { data } = await axios.get(`${ZD_BASE}/search.json?query=${q}`, { headers: ZH });
  return data.count > 0 ? data.results[0] : null;
}

/**
 * Upsert ticket.
 * If htmlBody is provided, it will be used (html_body). Otherwise plain body.
 */
async function createOrUpdateFromChatmeter({ reviewId, subject, body, htmlBody, requester = "reviews@drivo.com", tags = ["chatmeter","review","google"], customFields = [] }) {
  ensureZendeskEnv();
  if (!reviewId) throw new Error("Missing reviewId");

  const externalId = `chatmeter:${reviewId}`;
  const tagId = `cmrvw_${reviewId}`;
  const allTags = Array.from(new Set([...tags, tagId]));

  // find existing
  const existing = await findByExternalId(externalId);
  if (existing) {
    const ticket = { tags: allTags, comment: { public: true } };
    if (htmlBody) ticket.comment.html_body = htmlBody; else ticket.comment.body = body || "";
    await axios.put(`${ZD_BASE}/tickets/${existing.id}.json`, { ticket }, { headers: ZH });
    return { action: "updated", id: existing.id, externalId };
  }

  // create once
  const ticket = {
    subject,
    external_id: externalId,
    requester: { email: requester },
    tags: allTags,
    comment: { public: true }
  };
  if (htmlBody) ticket.comment.html_body = htmlBody; else ticket.comment.body = body || "";
  if (customFields?.length) ticket.custom_fields = customFields.map(cf => ({ id: Number(cf.id), value: cf.value }));

  const { data } = await axios.post(`${ZD_BASE}/tickets.json`, { ticket }, { headers: ZH });
  return { action: "created", id: data.ticket.id, externalId };
}

async function setCustomFields(ticketId, fieldsArray) {
  await axios.put(`${ZD_BASE}/tickets/${ticketId}.json`, { ticket: { custom_fields: fieldsArray } }, { headers: ZH });
}

module.exports = { createOrUpdateFromChatmeter, findByExternalId, setCustomFields, ZD_BASE, ZH };

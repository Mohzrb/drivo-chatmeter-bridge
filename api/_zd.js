// api/_zd.js
const axios = require("axios");

const ZD_BASE = "https://drivohelp.zendesk.com/api/v2";
const AUTH = "Basic " + Buffer.from(`mohamed@drivo.com/token:${process.env.ZD_TOKEN}`).toString("base64");

// ---- core guard ----
async function findByExternalId(externalId) {
  const q = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
  const { data } = await axios.get(`${ZD_BASE}/search.json?query=${q}`, {
    headers: { Authorization: AUTH }
  });
  return data.count > 0 ? data.results[0] : null;
}

async function createOrUpdateFromChatmeter({ reviewId, subject, body, requester = "reviews@drivo.com", tags = ["chatmeter","review"] }) {
  const externalId = `chatmeter:${reviewId}`;
  const tagId = `cmrvw_${reviewId}`;
  const allTags = Array.from(new Set([...tags, tagId]));

  const headers = { Authorization: AUTH, "Content-Type": "application/json" };

  const existing = await findByExternalId(externalId);
  if (existing) {
    await axios.put(`${ZD_BASE}/tickets/${existing.id}.json`, {
      ticket: { comment: { body, public: true }, tags: allTags }
    }, { headers });
    return { action: "updated", id: existing.id, externalId };
  }

  const { data } = await axios.post(`${ZD_BASE}/tickets.json`, {
    ticket: {
      subject,
      external_id: externalId,
      requester: { email: requester },
      comment: { body, public: true },
      tags: allTags
      // custom_fields: [{ id: <YOUR_CHATMETER_REVIEW_ID_FIELD>, value: reviewId }]
    }
  }, { headers });

  return { action: "created", id: data.ticket.id, externalId };
}

module.exports = { createOrUpdateFromChatmeter, findByExternalId };

// api/_zd.js
// Zendesk helper with idempotent create-or-update by external_id = chatmeter:<reviewId>

const axios = require("axios");

const ZD_BASE = "https://drivohelp.zendesk.com/api/v2";
const AUTH =
  "Basic " +
  Buffer.from(`mohamed@drivo.com/token:${process.env.ZD_TOKEN}`).toString("base64");

// --- search existing ticket by external_id ---
async function findByExternalId(externalId) {
  const q = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
  const { data } = await axios.get(`${ZD_BASE}/search.json?query=${q}`, {
    headers: { Authorization: AUTH },
  });
  return data.count > 0 ? data.results[0] : null;
}

// --- create or update a ticket from a Chatmeter review (NO DUPES) ---
async function createOrUpdateFromChatmeter({
  reviewId,
  subject,
  body,
  requester = "reviews@drivo.com",
  tags = ["chatmeter", "review", "google"],
  // customFieldId: optional numeric ticket field id for Chatmeter Review ID
  customFieldId,
}) {
  if (!reviewId) throw new Error("Missing reviewId");
  const externalId = `chatmeter:${reviewId}`;
  const tagId = `cmrvw_${reviewId}`;
  const allTags = Array.from(new Set([...tags, tagId]));
  const headers = { Authorization: AUTH, "Content-Type": "application/json" };

  // 1) Try to find an existing ticket for this review
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

  if (customFieldId) {
    ticket.custom_fields = [{ id: Number(customFieldId), value: reviewId }];
  }

  const { data } = await axios.post(
    `${ZD_BASE}/tickets.json`,
    { ticket },
    { headers }
  );

  return { action: "created", id: data.ticket.id, externalId };
}

module.exports = { createOrUpdateFromChatmeter, findByExternalId };


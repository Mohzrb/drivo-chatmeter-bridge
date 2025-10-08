// Zendesk → Chatmeter (post FIRST public reply), then mark ticket
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL,
    ZENDESK_API_TOKEN,
    ZD_FIELD_FIRST_REPLY_SENT
  } = process.env;

  const missing = [
    !CHATMETER_V5_TOKEN && "CHATMETER_V5_TOKEN",
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN"
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { ticket_id, review_id, reply_text } = body;
    if (!ticket_id || !review_id || !reply_text) {
      return res.status(400).send("Missing ticket_id/review_id/reply_text");
    }

    // 1) Post reply to Chatmeter – token is the Authorization header value (no Bearer)
    const chmRes = await fetch(`${CHATMETER_V5_BASE}/reviews/${encodeURIComponent(review_id)}/responses`, {
      method: "POST",
      headers: { "Authorization": CHATMETER_V5_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: String(reply_text) })
    });
    const chmTxt = await chmRes.text();
    if (!chmRes.ok) return res.status(502).send(`Chatmeter error: ${chmRes.status} ${chmTxt}`);

    // 2) Mark first-reply-sent in Zendesk
    const auth = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const payload = {
      ticket: {
        tags: ["chatmeter_first_reply_sent"],
        custom_fields: ZD_FIELD_FIRST_REPLY_SENT ? [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: true }] : []
      }
    };

    const zdRes = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify(payload)
    });

    if (!zdRes.ok) {
      const et = await zdRes.text();
      // Partial success (reply posted, Zendesk update failed)
      return res.status(207).send(`Reply sent but Zendesk update failed: ${zdRes.status} ${et}`);
    }

    res.status(200).json({ ok: true, review_id, posted_to_chatmeter: true, zendesk_ticket_updated: true });
  } catch (e) {
    res.status(500).send(`Error: ${e?.message || e}`);
  }
}

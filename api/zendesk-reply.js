export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const CHATMETER_V5_BASE = process.env.CHATMETER_V5_BASE;
  const CHATMETER_V5_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
  const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;

  if (!CHATMETER_V5_BASE || !CHATMETER_V5_TOKEN)
    return res.status(500).send("Missing Chatmeter env vars");

  try {
    const { ticket_id, review_id, reply_text } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!review_id || !reply_text)
      return res.status(400).send("Missing review_id or reply_text");

    // 1️⃣ Send reply to Chatmeter
    const cmRes = await fetch(
      `${CHATMETER_V5_BASE}/reviews/${review_id}/responses`,
      {
        method: "POST",
        headers: {
          "Authorization": CHATMETER_V5_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ detail: reply_text })
      }
    );

    const cmTxt = await cmRes.text();
    if (!cmRes.ok) {
      return res.status(502).send(`Chatmeter error: ${cmRes.status} ${cmTxt}`);
    }

    // 2️⃣ Optional: Update Zendesk field (mark First Reply Sent?)
    if (ZD_FIELD_FIRST_REPLY_SENT) {
      const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
      await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
        method: "PUT",
        headers: {
          "Authorization": "Basic " + auth,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ticket: {
            custom_fields: [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: true }]
          }
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).send(`Error: ${err.message}`);
  }
}

// Zendesk → Chatmeter (post FIRST public reply), then mark ticket in Zendesk
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN; // must be the raw token, no "Bearer "
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { ticket_id, review_id, reply_text } = body;
    if (!ticket_id || !review_id || !reply_text) {
      return res.status(400).send("Missing ticket_id/review_id/reply_text");
    }

    // 1) Post reply to Chatmeter – Auth header is the token itself
    const chmRes = await fetch(`${CHM_BASE}/reviews/${encodeURIComponent(review_id)}/responses`, {
      method: "POST",
      headers: { "Authorization": CHM_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: reply_text })
    });

    const chmTxt = await chmRes.text();
    if (!chmRes.ok) return res.status(502).send(`Chatmeter error: ${chmRes.status} ${chmTxt}`);

    // 2) Optional: mark first-reply-sent in Zendesk
    if (ZD_FIELD_FIRST_REPLY_SENT) {
      const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
      const zdRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
        body: JSON.stringify({
          ticket: {
            custom_fields: [{ id: +ZD_FIELD_FIRST_REPLY_SENT, value: true }],
            tags: ["chatmeter_first_reply_sent"]
          }
        })
      });
      if (!zdRes.ok) {
        const et = await zdRes.text();
        return res.status(207).send(`Reply sent but Zendesk update failed: ${zdRes.status} ${et}`);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

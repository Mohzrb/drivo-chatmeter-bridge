// Zendesk → Chatmeter (post FIRST public reply), then (optionally) mark ticket in Zendesk
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Required env
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN; // raw token from /v5/login (NO "Bearer ")
  const ZD_SUB    = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL  = process.env.ZENDESK_EMAIL;
  const ZD_TOKEN  = process.env.ZENDESK_API_TOKEN;

  // Optional env
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // checkbox field id (number)
  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // “Chatmeter Review ID” field id (number)

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !ZD_SUB && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    // Parse + normalize
    const bodyRaw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const body = safeJsonParse(bodyRaw, {});
    let { ticket_id, review_id, reply_text } = body;

    if (review_id && typeof review_id === "object") {
      review_id = review_id.id || review_id.reviewId || review_id.review_id || "";
    }
    review_id = String(review_id || "").trim();
    ticket_id = Number(ticket_id);
    reply_text = String(reply_text || "").trim();

    // If review_id not provided, pull it from the Zendesk ticket's custom fields
    if (!review_id && ticket_id && ZD_FIELD_REVIEW_ID) {
      const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString("base64");
      const td = await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
        headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
      });
      if (td.ok) {
        const tj = await td.json();
        const cf = tj?.ticket?.custom_fields?.find(f => String(f.id) === String(ZD_FIELD_REVIEW_ID));
        if (cf?.value) review_id = String(cf.value).trim();
      }
    }

    // Validate final payload
    if (!ticket_id || !review_id || !reply_text) {
      return res.status(400).send("Missing ticket_id/review_id/reply_text");
    }

    // 1) Post reply to Chatmeter — auth header is the token itself
    const cmResp = await fetch(`${CHM_BASE}/reviews/${encodeURIComponent(review_id)}/responses`, {
      method: "POST",
      headers: { "Authorization": CHM_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: reply_text }),
    });
    const cmText = await cmResp.text();
    if (!cmResp.ok) return res.status(502).send(`Chatmeter error: ${cmResp.status} ${truncate(cmText, 500)}`);

    // 2) Optionally mark "First Reply Sent?" in Zendesk
    let zdUpdated = false;
    if (ZD_FIELD_FIRST_REPLY_SENT) {
      const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString("base64");
      const zdResp = await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
        method: "PUT",
        headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: {
            custom_fields: [{ id: Number(ZD_FIELD_FIRST_REPLY_SENT), value: true }],
            tags: ["chatmeter_first_reply_sent"],
          },
        }),
      });
      if (!zdResp.ok) {
        const et = await zdResp.text();
        return res.status(207).send(`Reply sent, but Zendesk update failed: ${zdResp.status} ${truncate(et, 500)}`);
      }
      zdUpdated = true;
    }

    return res.status(200).json({ ok: true, review_id, posted_to_chatmeter: true, zendesk_ticket_updated: zdUpdated });
  } catch (err) {
    return res.status(500).send(`Error: ${err?.message || err}`);
  }
}

// helpers
function safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function truncate(str, n) { if (typeof str !== "string") return ""; return str.length > n ? str.slice(0, n) + "…" : str; }

// /api/review-webhook.js
// Creates ONE Zendesk ticket per review (requester = reviews@drivo.com)
// Adds ONE internal “Review Information” card.
// De-dupe by external_id (chatmeter:<id>) and tag (cmrvw_<id>).

export const config = { runtime: "nodejs" };

// ---------- Helpers ----------
function zdAuth() {
  const sub   = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;
  if (!sub || !email || !token) throw new Error("Missing Zendesk env");
  const auth = Buffer.from(`${email}/token:${token}`).toString("base64");
  return { sub, headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json", "Accept": "application/json" } };
}

function htmlEsc(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function ratingStars(n) {
  const rn = Math.max(0, Math.min(5, parseInt(n || 0, 10)));
  return "★".repeat(rn) + "☆".repeat(5 - rn);
}

function buildInternalHtml(p) {
  const dt = htmlEsc(p.createdAt || "");
  const cust = htmlEsc(p.authorName || "Reviewer");
  const prov = htmlEsc(p.provider || "");
  const locName = htmlEsc(p.locationName || "");
  const locId = htmlEsc(p.locationId || "");
  const comment = htmlEsc(p.text || "(no text)");
  const link = htmlEsc(p.publicUrl || "");
  const stars = ratingStars(p.rating);

  const linkHtml = link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">View in Chatmeter</a>` : "View in Chatmeter";

  return `
<div style="background:#fff4e5;border:1px solid #f1d3a8;border-radius:6px;padding:12px">
  <strong>Review Information</strong><br/><br/>
  <strong>Date:</strong> ${dt}<br/>
  <strong>Customer:</strong> ${cust}<br/>
  <strong>Provider:</strong> ${prov}<br/>
  <strong>Location:</strong> ${locName || locId}${locName && locId ? ` (${locId})` : ""}<br/>
  <strong>Rating:</strong> ${stars}<br/>
  <strong>Comment:</strong><br/>${comment.replace(/\n/g,"<br/>")}<br/><br/>
  ${linkHtml}
  <div style="margin-top:10px;color:#666;font-style:italic">
    The first public comment on this ticket will be posted to Chatmeter.
  </div>
</div>`.trim();
}

function inferSubject(p) {
  const name = p.locationName || p.locationId || "Location";
  const stars = parseInt(p.rating || 0, 10) || 0;
  const reviewer = p.authorName || "Reviewer";
  return `${name} – ${"★".repeat(stars) || "–"} – ${reviewer}`;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // payload: { id, provider, locationId, locationName, rating, authorName, authorEmail, createdAt, text, publicUrl }
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const required = ["id", "rating"];
  for (const k of required) {
    if (!body[k]) return res.status(400).send(`Missing ${k}`);
  }

  try {
    const { sub, headers } = zdAuth();

    const reviewId = String(body.id);
    const externalId = `chatmeter:${reviewId}`;
    const uniqTag = `cmrvw_${reviewId}`;
    const providerTag = (body.provider || "chatmeter").toLowerCase();

    // 1) find existing by external_id
    const sr = await fetch(`https://${sub}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(`external_id:${externalId}`)}`, { headers });
    const stext = await sr.text();
    if (!sr.ok) return res.status(502).send(`Zendesk search failed: ${stext}`);
    const sData = JSON.parse(stext || "{}");
    const match = (sData.results || []).find(r => r.external_id === externalId);

    const commonTicket = {
      external_id: externalId,
      subject: inferSubject(body),
      requester: { email: "reviews@drivo.com", name: "Chatmeter" },
      tags: ["chatmeter", providerTag, uniqTag],
      custom_fields: [
        { id: Number(process.env.ZD_FIELD_REVIEW_ID), value: reviewId },
        { id: Number(process.env.ZD_FIELD_LOCATION_ID), value: body.locationId || "" },
        { id: Number(process.env.ZD_FIELD_RATING), value: Number(body.rating || 0) },
        ...(process.env.ZD_FIELD_LOCATION_NAME
          ? [{ id: Number(process.env.ZD_FIELD_LOCATION_NAME), value: body.locationName || "" }]
          : [])
      ],
    };

    const html = buildInternalHtml(body);

    if (!match) {
      // 2) create ticket with ONE internal note
      const createPayload = {
        ticket: {
          ...commonTicket,
          comment: { html_body: html, public: false },
        }
      };
      const cr = await fetch(`https://${sub}.zendesk.com/api/v2/tickets.json`, {
        method: "POST", headers, body: JSON.stringify(createPayload)
      });
      const ctext = await cr.text();
      if (!cr.ok) return res.status(502).send(`Zendesk create failed: ${ctext}`);

      // do NOT add any more comments here -> exactly one internal card
      const cData = JSON.parse(ctext || "{}");
      return res.json({ ok: true, action: "created", id: cData?.ticket?.id, externalId });
    }

    // 3) exists: just ensure tags & fields (do not add extra internal notes)
    const updatePayload = {
      ticket: {
        ...commonTicket,
      }
    };
    const ur = await fetch(`https://${sub}.zendesk.com/api/v2/tickets/${match.id}.json`, {
      method: "PUT", headers, body: JSON.stringify(updatePayload)
    });
    const utext = await ur.text();
    if (!ur.ok) return res.status(502).send(`Zendesk update failed: ${utext}`);

    return res.json({ ok: true, action: "updated", id: match.id, externalId });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

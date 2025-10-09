// api/review-webhook.js
//
// Chatmeter -> Zendesk (one ticket per review).
// - requester: reviews@drivo.com
// - external_id = chatmeter:<reviewId>
// - one INTERNAL "Review Information" card
// - sets custom fields (env IDs)

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // env (Zendesk)
    const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
    const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
    const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

    const FIELD_REVIEW_ID   = toNum(process.env.ZD_FIELD_REVIEW_ID);
    const FIELD_LOCATION_ID = toNum(process.env.ZD_FIELD_LOCATION_ID);
    const FIELD_RATING      = toNum(process.env.ZD_FIELD_RATING);
    const FIELD_FIRST_REPLY = toNum(process.env.ZD_FIELD_FIRST_REPLY_SENT);
    const FIELD_LOCATION_NAME = toNum(process.env.ZD_FIELD_LOCATION_NAME); // optional

    const missing = [
      !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
      !ZD_EMAIL && "ZENDESK_EMAIL",
      !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
      !FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
      !FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
      !FIELD_RATING && "ZD_FIELD_RATING",
      !FIELD_FIRST_REPLY && "ZD_FIELD_FIRST_REPLY_SENT"
    ].filter(Boolean);

    if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

    // payload from poller (or manual)
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      id, provider, rating, authorName, authorEmail, createdAt,
      text, publicUrl, locationId, locationName
    } = body;

    if (!id) return res.status(400).send("Missing review id");

    const externalId = `chatmeter:${id}`;

    // 1) Check if ticket already exists (dedupe)
    const existing = await zdGET(`/api/v2/search.json?query=type:ticket external_id:"${encodeURIComponent(externalId)}"`, auth, ZD_SUBDOMAIN);
    const ticket = Array.isArray(existing?.results) && existing.results.length ? existing.results[0] : null;

    const card = formatInternalCard({
      createdAt, customer: authorName, provider, locationName, locationId, rating, text, publicUrl
    });

    // Build fields & tags
    const custom_fields = [
      { id: FIELD_REVIEW_ID,   value: String(id) },
      { id: FIELD_LOCATION_ID, value: toNumOrNull(locationId) },
      { id: FIELD_RATING,      value: toNumOrNull(rating) },
      { id: FIELD_FIRST_REPLY, value: false },
    ];
    if (FIELD_LOCATION_NAME && locationName) {
      // if it's a tagger/dropdown, value should be the tag; if it's text, Zendesk accepts string
      custom_fields.push({ id: FIELD_LOCATION_NAME, value: String(locationName) });
    }
    const providerTag = String(provider || "unknown").toLowerCase();
    const reviewTag   = `cmrvw_${String(id).replace(/[^a-zA-Z0-9_]/g, "")}`;
    const tags = ["chatmeter", providerTag, "review", reviewTag];

    // 2) Create or update
    if (!ticket) {
      // Create ticket with INTERNAL first message
      const subjectLoc = locationName || locationId || "Location";
      const subject = `${subjectLoc} – ${rating}★ – ${authorName || "Reviewer"}`;

      const createPayload = {
        ticket: {
          subject,
          external_id: externalId,
          requester: { name: "reviews@drivo.com", email: "reviews@drivo.com" },
          tags,
          custom_fields,
          comment: {
            body: card,
            public: false // INTERNAL
          }
        }
      };
      const created = await zdPOST(`/api/v2/tickets.json`, auth, ZD_SUBDOMAIN, createPayload);
      const tid = created?.ticket?.id;
      return res.status(200).json({ ok: true, action: "created", id: tid, externalId });
    } else {
      // Ticket exists: we do NOT add more internal cards here to avoid duplicates.
      // We still ensure the custom fields/tags are present (idempotent).
      const updatePayload = {
        ticket: {
          tags,
          custom_fields
        }
      };
      await zdPUT(`/api/v2/tickets/${ticket.id}.json`, auth, ZD_SUBDOMAIN, updatePayload);
      return res.status(200).json({ ok: true, action: "updated", id: ticket.id, externalId });
    }

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------------- helpers ---------------- */

function toNum(x){ const n = parseInt(x,10); return Number.isFinite(n) ? n : 0; }
function toNumOrNull(x){ const n = parseInt(x,10); return Number.isFinite(n) ? n : null; }

function stars(n) {
  const v = Math.max(0, Math.min(5, parseInt(n,10) || 0));
  return "★".repeat(v) + "☆".repeat(5 - v);
}
function esc(s){ return String(s || "").replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])); }

function formatInternalCard({ createdAt, customer, provider, locationName, locationId, rating, text, publicUrl }) {
  // GitHub-style / Zendesk Markdown
  return (
`Review Information
Date: ${esc(createdAt || "")}
Customer: ${esc(customer || "")}
Provider: ${esc(provider || "")}
Location: ${esc(locationName || "")} (${esc(locationId || "")})
Rating: ${stars(rating)}
Comment:
${text ? esc(text) : "(no text)"}

[View in Chatmeter](${esc(publicUrl || "")})

_The first public comment on this ticket will be posted to Chatmeter._`
  );
}

// --- Zendesk tiny client
async function zdGET(path, auth, sub) {
  const r = await fetch(`https://${sub}.zendesk.com${path}`, { headers: { Authorization: auth, "Accept":"application/json" }});
  const t = await r.text();
  if (!r.ok) throw new Error(`Zendesk GET ${path} failed: ${r.status} ${t}`);
  return JSON.parse(t);
}
async function zdPOST(path, auth, sub, body) {
  const r = await fetch(`https://${sub}.zendesk.com${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", "Accept":"application/json" },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Zendesk POST ${path} failed: ${r.status} ${t}`);
  return JSON.parse(t);
}
async function zdPUT(path, auth, sub, body) {
  const r = await fetch(`https://${sub}.zendesk.com${path}`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "Accept":"application/json" },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Zendesk PUT ${path} failed: ${r.status} ${t}`);
  return JSON.parse(t);
}

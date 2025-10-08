// api/review-webhook-v2.js
// Idempotent upsert + beige internal card + duplicate sweep (ESM / fetch)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const SUB = process.env.ZENDESK_SUBDOMAIN;
  const EMAIL = process.env.ZENDESK_EMAIL;
  const TOKEN = process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN;

  const F_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;
  const F_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;
  const F_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME; // optional
  const F_RATING           = process.env.ZD_FIELD_RATING;
  const F_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // optional

  const missing = [
    !SUB && "ZENDESK_SUBDOMAIN",
    !EMAIL && "ZENDESK_EMAIL",
    !TOKEN && "ZENDESK_API_TOKEN/ZD_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).json({ error: `Missing env: ${missing.join(", ")}` });

  const auth = "Basic " + Buffer.from(`${EMAIL}/token:${TOKEN}`).toString("base64");
  const Z = async (path, init = {}) => {
    const r = await fetch(`https://${SUB}.zendesk.com${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": auth, ...(init.headers||{}) }
    });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, json: safeParse(txt, {}), txt };
  };

  try {
    // ---- normalize input ----
    const b = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{});
    const reviewId     = s(b.id ?? b.reviewId ?? b.review_id);
    if (!reviewId) return res.status(400).json({ error: "Missing reviewId" });

    const rating       = n(b.rating ?? b.stars);
    const locationId   = s(b.locationId ?? b.location_id);
    const locationName = s(b.locationName ?? b.location ?? b.businessName) || "Location";
    const authorName   = s(b.authorName ?? b.author ?? b.reviewer) || "Reviewer";
    const createdAt    = s(b.createdAt ?? b.date ?? b.review_date ?? b.created_at) || "N/A";
    const text         = s(b.text ?? b.comment ?? b.reviewText ?? b.review_text ?? b.content ?? b.body) || "(no text)";
    const publicUrl    = s(b.publicUrl ?? b.public_url ?? b.reviewURL ?? b.url ?? b.link) || "(none)";
    const provider     = inferProvider(s(b.provider ?? b.source ?? b.contentProvider), publicUrl);

    const externalId = `chatmeter:${reviewId}`;
    const tagId = `cmrvw_${reviewId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0,60)}`;
    const providerTag = provider.toLowerCase();

    // ---- look up existing by external_id (fast path), then search, then tag ----
    let ticketId = await lookupByExternalId(Z, externalId)
                || await searchOne(Z, `type:ticket external_id:"${externalId}"`)
                || await searchOne(Z, `type:ticket tags:${tagId}`);

    const subject = `${locationName} – ${rating ?? "?"}★ – ${authorName}`;
    const body = buildCard({ reviewId, provider, locationName, locationId, rating, createdAt, text, publicUrl });

    const custom_fields = [];
    if (F_REVIEW_ID)        custom_fields.push({ id: +F_REVIEW_ID,        value: reviewId });
    if (F_LOCATION_ID)      custom_fields.push({ id: +F_LOCATION_ID,      value: locationId });
    if (F_LOCATION_NAME)    custom_fields.push({ id: +F_LOCATION_NAME,    value: locationName });
    if (F_RATING)           custom_fields.push({ id: +F_RATING,           value: rating ?? null });
    if (F_FIRST_REPLY_SENT) custom_fields.push({ id: +F_FIRST_REPLY_SENT, value: false });

    const tags = ["chatmeter","review","bridge_v2", tagId, providerTag].filter(Boolean);

    if (ticketId) {
      const upd = await Z(`/api/v2/tickets/${ticketId}.json`, {
        method: "PUT",
        body: JSON.stringify({ ticket: { comment: { body, public: false }, tags, ...(custom_fields.length?{custom_fields}:{}) } })
      });
      if (!upd.ok) return res.status(502).json({ error: `Zendesk update ${upd.status}`, detail: upd.txt });
      // sweep duplicates just in case
      await sweepDupes(Z, externalId, ticketId);
      return res.status(200).json({ ok: true, version: "v2", action: "updated", ticketId });
    }

    // create (idempotent header)
    const create = await Z(`/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Idempotency-Key": externalId },
      body: JSON.stringify({
        ticket: {
          external_id: externalId,
          subject,
          requester: { name: authorName, email: "reviews@drivo.com" },
          comment: { body, public: false }, // beige internal
          tags,
          ...(custom_fields.length?{custom_fields}:{})
        }
      })
    });
    if (!create.ok) return res.status(502).json({ error: `Zendesk create ${create.status}`, detail: create.txt });

    ticketId = create.json?.ticket?.id ?? null;

    // warm + sweep
    await lookupByExternalId(Z, externalId).catch(()=>{});
    await sweepDupes(Z, externalId, ticketId);

    return res.status(200).json({ ok: true, version: "v2", action: "created", ticketId });

  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

/* -------- helpers -------- */
const s = v => (v===undefined||v===null) ? "" : String(v).trim();
const n = v => (v===undefined||v===null||String(v).trim()==="") ? null : Number(v);
function safeParse(t, fb){ try{ return JSON.parse(t);}catch{ return fb; } }

function inferProvider(p, url) {
  const x = (p||"").toUpperCase();
  if (x) return x;
  try {
    if (url) {
      const h = new URL(url).hostname;
      if (/google/i.test(h)) return "GOOGLE";
      if (/yelp/i.test(h)) return "YELP";
      if (/facebook|fb\.com/i.test(h)) return "FACEBOOK";
      if (/chatmeter/i.test(h)) return "REVIEWBUILDER";
    }
  } catch {}
  return "PROVIDER";
}

function buildCard({ reviewId, provider, locationName, locationId, rating, createdAt, text, publicUrl }) {
  const lines = [
    `Review ID: ${reviewId}`,
    `Provider: ${provider || "N/A"}`,
    `Location: ${locationName}${locationId ? ` (${locationId})` : ""}`,
    `Rating: ${rating ?? "N/A"}★`,
    `Date: ${createdAt || "N/A"}`,
    `Review Text:`,
    ``,
    text || `(no text)`,
    ``,
    `Public URL:`,
    publicUrl || `(none)`
  ];
  return lines.join("\n");
}

async function lookupByExternalId(Z, externalId) {
  const r = await Z(`/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(externalId)}`);
  return (r.ok && r.json?.tickets?.[0]?.id) ? r.json.tickets[0].id : null;
}

async function searchOne(Z, q) {
  const r = await Z(`/api/v2/search.json?query=${encodeURIComponent(q)}&per_page=1`);
  return (r.ok && r.json?.results?.[0]?.id) ? r.json.results[0].id : null;
}

async function sweepDupes(Z, externalId, keepId) {
  if (!keepId) return;
  const r = await Z(`/api/v2/search.json?query=${encodeURIComponent(`type:ticket external_id:"${externalId}"`)}&per_page=25`);
  const ids = (r.ok && Array.isArray(r.json?.results)) ? r.json.results.map(x=>x.id) : [];
  const dupes = ids.filter(id => id !== keepId);
  for (const id of dupes) {
    try {
      await Z(`/api/v2/tickets/${id}.json`, {
        method: "PUT",
        body: JSON.stringify({ ticket: { status: "closed", comment: { public:false, body:`Auto-closed duplicate of #${keepId} (same Chatmeter review).` }, tags:["duplicate_closed"] } })
      });
    } catch {}
  }
}

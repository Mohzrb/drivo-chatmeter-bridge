// Chatmeter → Zendesk (idempotent upsert, resilient lookup, beige internal card)
// ESM / Vercel-compatible

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN || process.env.ZD_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME; // optional
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // optional

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN/ZD_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const authBasic = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
  const Z = async (path, init = {}) => {
    const r = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Basic ${authBasic}`,
        ...(init.headers || {})
      }
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, json: safeParse(text, {}) };
  };

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // --- normalize inputs (cover common synonyms; keep your canonical keys first) ---
    const reviewId     = str(b.id ?? b.reviewId ?? b.review_id);
    if (!reviewId) return res.status(400).send("Missing review id");

    const rating       = num(b.rating ?? b.stars);
    const locationId   = str(b.locationId ?? b.location_id);
    const locationName = str(b.locationName ?? b.location ?? b.businessName ?? "Location");
    const authorName   = str(b.authorName ?? b.author ?? b.reviewer ?? "Reviewer");
    const createdAt    = str(b.createdAt ?? b.date ?? b.review_date ?? b.created_at);
    const text         = str(b.text ?? b.comment ?? b.reviewText ?? b.review_text ?? b.content ?? b.body ?? "");
    const publicUrl    = str(b.publicUrl ?? b.public_url ?? b.reviewURL ?? b.url ?? b.link ?? "");
    const provider     = inferProvider(str(b.provider ?? b.source ?? b.contentProvider), publicUrl);

    // idempotency key / unique tag
    const externalId = `chatmeter:${reviewId}`;
    const uniqueTag  = `cmrvw_${reviewId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60)}`;
    const providerTag = provider ? provider.toLowerCase() : undefined;

    // ---------- RESILIENT LOOKUP (prevents duplicates) ----------
    // A) Fast path: show_many by external_id (no search lag)
    let ticketId = await lookupByExternalId(Z, externalId);

    // B) Fallback: Search API by external_id
    if (!ticketId) ticketId = await searchOne(Z, `type:ticket external_id:"${externalId}"`);

    // C) Last-resort: search by our unique tag (covers very early tickets created w/o external_id)
    if (!ticketId) ticketId = await searchOne(Z, `type:ticket tags:${uniqueTag}`);

    // Card body (plain text → renders as beige internal note)
    const body = buildCard({ reviewId, provider, locationName, locationId, rating, createdAt, text, publicUrl });

    // Common custom fields array
    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: reviewId });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: locationId });
    if (ZD_FIELD_LOCATION_NAME && locationName) custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating || null });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });

    const subject = `${locationName} – ${rating || "?"}★ – ${authorName}`;

    if (ticketId) {
      // ---------- UPDATE (idempotent path) ----------
      const upd = await Z(`/api/v2/tickets/${ticketId}.json`, {
        method: "PUT",
        body: JSON.stringify({
          ticket: {
            comment: { body, public: false },            // internal beige card
            tags: ["chatmeter", "review", uniqueTag, providerTag].filter(Boolean),
            ...(custom_fields.length ? { custom_fields } : {})
          }
        })
      });
      if (!upd.ok) return res.status(502).send(`Zendesk update error: ${upd.status} ${upd.text}`);
      return res.status(200).json({ ok: true, action: "updated", ticketId });
    }

    // ---------- CREATE (idempotent with Idempotency-Key) ----------
    const create = await Z(`/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Idempotency-Key": externalId },
      body: JSON.stringify({
        ticket: {
          external_id: externalId,
          subject,
          comment: { body, public: false },              // internal beige card on create
          requester: { name: authorName, email: "reviews@drivo.com" },
          tags: ["chatmeter", "review", uniqueTag, providerTag].filter(Boolean),
          ...(custom_fields.length ? { custom_fields } : {})
        }
      })
    });
    if (!create.ok) return res.status(502).send(`Zendesk create error: ${create.status} ${create.text}`);

    // warm up cache so future lookups see it immediately
    await lookupByExternalId(Z, externalId).catch(()=>{});
    const createdId = create.json?.ticket?.id ?? null;
    return res.status(200).json({ ok: true, action: "created", ticketId: createdId });

  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

/* ---------- helpers ---------- */

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v) => (v === undefined || v === null || String(v).trim()==="" ? null : Number(v));

function inferProvider(p, url) {
  const x = (p || "").toUpperCase();
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
    `Location: ${locationName || "Location"}${locationId ? ` (${locationId})` : ""}`,
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
  if (r.ok && r.json?.tickets?.[0]?.id) return r.json.tickets[0].id;
  return null;
}

async function searchOne(Z, query) {
  const r = await Z(`/api/v2/search.json?query=${encodeURIComponent(query)}&per_page=1`);
  if (r.ok && Array.isArray(r.json?.results) && r.json.results[0]?.id) return r.json.results[0].id;
  return null;
}

// Chatmeter → Zendesk (idempotent, with resilient lookup + Idempotency-Key)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
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
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId = String(b.id || b.reviewId || b.review_id || "").trim();
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = String(b.locationId ?? "");
    const locationName = String(b.locationName ?? "Unknown");
    const rating       = (typeof b.rating === "number" ? b.rating : Number(b.rating || 0)) || 0;
    const authorName   = String(b.authorName ?? "Chatmeter Reviewer");
    const createdAt    = String(b.createdAt ?? "");
    const text         = String(b.text ?? b.comment ?? b.reviewText ?? "");
    const publicUrl    = String(b.publicUrl ?? b.reviewURL ?? "");
    const provider     = String(b.provider ?? b.contentProvider ?? "").toUpperCase();

    const externalId = `chatmeter:${reviewId}`;
    const uniqueTag  = `cmrvw_${reviewId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60)}`;

    // ---------- LOOKUP PHASE ----------
    // A) Primary: show_many external_ids (no search-index lag)
    let foundTicketId = null;
    {
      const lookup = await Z(`/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(externalId)}`);
      if (lookup.ok) {
        const t = lookup.json?.tickets?.[0];
        if (t?.id) foundTicketId = t.id;
      } else if (lookup.status !== 404) {
        // capture text to help diagnose odd 400s, then fall back
        // (we won't fail here; just try the search path below)
      }
    }

    // B) Fallback: Search API (handles pods that 400 on show_many external_ids)
    if (!foundTicketId) {
      const q = encodeURIComponent(`type:ticket external_id:"${externalId}"`);
      const sr = await Z(`/api/v2/search.json?query=${q}&per_page=1`);
      if (sr.ok && Array.isArray(sr.json?.results) && sr.json.results[0]?.id) {
        foundTicketId = sr.json.results[0].id;
      }
    }

    // If found → touch & return
    if (foundTicketId) {
      await safeTouch(foundTicketId, Z);
      return res.status(200).json({ ok: true, deduped: true, via: "lookup", ticketId: foundTicketId });
    }

    // ---------- CREATE PHASE ----------
    const subject = `${locationName} – ${rating}★ – ${authorName}`;
    const description = [
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "N/A"}`,
      `Location: ${locationName}${locationId ? ` (${locationId})` : ""}`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Public URL:",
      publicUrl || "(none)"
    ].filter(Boolean).join("\n");

    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: reviewId });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: locationId });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locationName) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName });
    }

    const create = await Z(`/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Idempotency-Key": externalId }, // collapse near-simultaneous creates
      body: JSON.stringify({
        ticket: {
          external_id: externalId,
          subject,
          comment: { body: description, public: false }, // internal summary on create
          requester: { name: authorName, email: "reviews@drivo.com" },
          custom_fields,
          tags: ["chatmeter", "review", uniqueTag, provider.toLowerCase()].filter(Boolean)
        }
      })
    });

    if (!create.ok) {
      return res.status(502).send(`Zendesk create error: ${create.status} ${create.text}`);
    }

    const createdId = create.json?.ticket?.id ?? null;

    // After create, do a second **show_many** to ensure subsequent calls see it immediately
    // (ignores errors; just a warm-up)
    await Z(`/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(externalId)}`);

    return res.status(200).json({ ok: true, createdTicketId: createdId });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

async function safeTouch(ticketId, Z) {
  try {
    await Z(`/api/v2/tickets/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        ticket: {
          comment: { body: "Chatmeter duplicate suppressed (idempotent).", public: false },
          tags: ["chatmeter", "review", "deduped"]
        }
      })
    });
  } catch {}
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

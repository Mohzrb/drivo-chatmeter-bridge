// api/review-webhook.js
// Chatmeter → Zendesk (idempotent via external_id)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  const ZD_FIELD_REVIEW_ID        = process.env.ZD_FIELD_REVIEW_ID;        // 35430266638231
  const ZD_FIELD_LOCATION_ID      = process.env.ZD_FIELD_LOCATION_ID;      // 35440761054615
  const ZD_FIELD_RATING           = process.env.ZD_FIELD_RATING;           // 35440783828759
  const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // 35430318419351
  const ZD_FIELD_LOCATION_NAME    = process.env.ZD_FIELD_LOCATION_NAME;    // (optional)

  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const reviewId     = body.id || body.reviewId || body.review_id;
    if (!reviewId) return res.status(400).send("Missing review id");

    const locationId   = body.locationId ?? "";
    const locationName = body.locationName ?? "";
    const rating       = body.rating ?? 0;
    const authorName   = body.authorName ?? "Chatmeter Reviewer";
    const createdAt    = body.createdAt ?? "";
    const text         = body.text ?? "";
    const publicUrl    = body.publicUrl ?? body.reviewURL ?? "";
    const provider     = body.provider || body.contentProvider || "";

    // Subject + description
    const subject = `${locationName || locationId || "Unknown"} – ${rating}★ – ${authorName}`.trim();
    const description = [
      `Review ID: ${reviewId}`,
      `Provider: ${provider || "Unknown"}`,
      `Location: ${locationName || "(name unknown)"} (${locationId || "-"})`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : "",
    ].filter(Boolean).join("\n");

    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");

    // ---------- DEDUPE VIA external_id ----------
    const externalId = `chatmeter:${reviewId}`;

    // Fast lookup by external_id
    const showMany = await fetch(
      `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?external_ids=${encodeURIComponent(externalId)}`,
      { headers: { Authorization: "Basic " + auth } }
    );
    const showJson = await showMany.json().catch(() => ({}));
    const existingId = showJson?.tickets?.[0]?.id;

    // Custom fields (create or update)
    const custom_fields = [];
    if (ZD_FIELD_REVIEW_ID)        custom_fields.push({ id: +ZD_FIELD_REVIEW_ID,        value: String(reviewId) });
    if (ZD_FIELD_LOCATION_ID)      custom_fields.push({ id: +ZD_FIELD_LOCATION_ID,      value: String(locationId || "") });
    if (ZD_FIELD_RATING)           custom_fields.push({ id: +ZD_FIELD_RATING,           value: rating || 0 });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (ZD_FIELD_LOCATION_NAME && locationName)
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: String(locationName) });

    // Shared tags
    const tags = ["chatmeter", "review", `cm_provider_${(provider || "unknown").toLowerCase()}`];

    if (existingId) {
      // ---------- Update existing ticket (no duplicate) ----------
      const upd = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${existingId}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Basic " + auth
        },
        body: JSON.stringify({
          ticket: {
            subject, // keep it fresh
            tags,
            custom_fields,
            comment: {
              body: "Chatmeter update received (dedupe – no new ticket).",
              public: false
            }
          }
        })
      });
      if (!upd.ok) {
        const et = await upd.text();
        return res.status(207).send(`OK (deduped) but update failed: ${upd.status} ${et}`);
      }
      return res.status(200).json({ ok: true, deduped: true, ticketId: existingId });
    }

    // ---------- Create new ticket (with external_id) ----------
    const createPayload = {
      ticket: {
        external_id: externalId,
        subject,
        comment: { body: description, public: true },
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags,
        custom_fields
      }
    };

    const create = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body: JSON.stringify(createPayload)
    });
    const createTxt = await create.text();
    if (!create.ok) return res.status(502).send(`Zendesk create error: ${create.status} ${createTxt}`);

    const created = safeParse(createTxt, {});
    return res.status(200).json({ ok: true, createdTicketId: created?.ticket?.id ?? null });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

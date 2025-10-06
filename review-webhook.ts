// Chatmeter → Zendesk (create ticket)
// Deployed on Vercel as: POST https://<your-app>.vercel.app/api/review-webhook

const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZD_EMAIL = process.env.ZENDESK_EMAIL;
const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZD_FIELD_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID;               // number as string
const ZD_FIELD_LOCATION_ID = process.env.ZD_FIELD_LOCATION_ID;           // number as string
const ZD_FIELD_RATING = process.env.ZD_FIELD_RATING;                     // number as string
const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT; // number as string

function badEnv() {
  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  return missing.length ? `Missing env: ${missing.join(", ")}` : null;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const envErr = badEnv();
    if (envErr) { res.status(500).send(envErr); return; }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const reviewId = body.id || body.reviewId || "";
    const locationId = body.locationId ?? "";
    const locationName = body.locationName ?? "Unknown Location";
    const rating = body.rating ?? 0;
    const authorName = body.authorName ?? "Chatmeter Reviewer";
    const createdAt = body.createdAt ?? "";
    const text = body.text ?? "";
    const publicUrl = body.publicUrl ?? "";
    const portalUrl = body.portalUrl ?? "";

    if (!reviewId) {
      res.status(400).send("Missing reviewId/id");
      return;
    }

    const subject = `${locationName} – ${rating}★ – ${authorName}`;
    const description = [
      `Review ID: ${reviewId}`,
      `Location: ${locationName} (${locationId})`,
      `Rating: ${rating}★`,
      createdAt ? `Date: ${createdAt}` : "",
      "",
      "Review Text:",
      text || "(no text)",
      "",
      "Links:",
      publicUrl ? `Public URL: ${publicUrl}` : "",
      portalUrl ? `Chatmeter URL: ${portalUrl}` : ""
    ].filter(Boolean).join("\n");

    const ticket: any = {
      ticket: {
        subject,
        comment: { body: description, public: true },
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound"]
      }
    };

    const custom_fields: { id: number; value: any }[] = [];
    if (ZD_FIELD_REVIEW_ID) custom_fields.push({ id: +ZD_FIELD_REVIEW_ID, value: String(reviewId) });
    if (ZD_FIELD_LOCATION_ID) custom_fields.push({ id: +ZD_FIELD_LOCATION_ID, value: String(locationId) });
    if (ZD_FIELD_RATING) custom_fields.push({ id: +ZD_FIELD_RATING, value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (custom_fields.length) ticket.ticket.custom_fields = custom_fields;

    const auth = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
    const zdRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + auth
      },
      body: JSON.stringify(ticket)
    });

    if (!zdRes.ok) {
      const errTxt = await zdRes.text();
      res.status(502).send(`Zendesk error: ${zdRes.status} ${errTxt}`);
      return;
    }

    const data = await zdRes.json();
    res.status(200).json({ ok: true, createdTicketId: data?.ticket?.id ?? null });
  } catch (e: any) {
    res.status(500).send(`Error: ${e?.message || e}`);
  }
}

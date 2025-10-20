// Chatmeter → Zendesk (create ticket)
// Deployed on Vercel as: POST https://<your-app>.vercel.app/api/review-webhook

type ReviewPayload = {
  id?: string;
  reviewId?: string;            // allow either id or reviewId
  locationId?: string | number;
  locationName?: string;
  rating?: number;
  authorName?: string;
  createdAt?: string;
  text?: string;
  publicUrl?: string;
  portalUrl?: string;
};

const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN!;
const ZD_EMAIL = process.env.ZENDESK_EMAIL!;
const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN!;
const ZD_FIELD_REVIEW_ID = process.env.ZD_FIELD_REVIEW_ID;                 // number as string
const ZD_FIELD_LOCATION_ID = process.env.ZD_FIELD_LOCATION_ID;             // number as string
const ZD_FIELD_RATING = process.env.ZD_FIELD_RATING;                       // number as string
const ZD_FIELD_FIRST_REPLY_SENT = process.env.ZD_FIELD_FIRST_REPLY_SENT;   // number as string

function badEnv() {
  const missing = [
    !ZD_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZD_EMAIL && "ZENDESK_EMAIL",
    !ZD_API_TOKEN && "ZENDESK_API_TOKEN",
  ].filter(Boolean);
  return missing.length ? `Missing env: ${missing.join(", ")}` : null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const envErr = badEnv();
    if (envErr) return new Response(envErr, { status: 500 });

    const body = (await req.json()) as ReviewPayload;

    // Normalize fields
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
      return new Response("Missing reviewId/id", { status: 400 });
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

    // Build Zendesk ticket payload
    const ticket: any = {
      ticket: {
        subject,
        comment: { body: description, public: true },
        requester: { name: authorName, email: "reviews@drivo.com" },
        tags: ["chatmeter", "review", "inbound"],
      }
    };

    // Optional custom fields if you set their IDs
    const custom_fields: { id: number; value: any }[] = [];
    if (ZD_FIELD_REVIEW_ID) custom_fields.push({ id: +ZD_FIELD_REVIEW_ID, value: String(reviewId) });
    if (ZD_FIELD_LOCATION_ID) custom_fields.push({ id: +ZD_FIELD_LOCATION_ID, value: String(locationId) });
    if (ZD_FIELD_RATING) custom_fields.push({ id: +ZD_FIELD_RATING, value: rating });
    if (ZD_FIELD_FIRST_REPLY_SENT) custom_fields.push({ id: +ZD_FIELD_FIRST_REPLY_SENT, value: false });
    if (custom_fields.length) ticket.ticket.custom_fields = custom_fields;

    // Create the ticket
    const zendeskRes = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64"),
      },
      body: JSON.stringify(ticket),
    });

    if (!zendeskRes.ok) {
      const errTxt = await zendeskRes.text();
      return new Response(`Zendesk error: ${zendeskRes.status} ${errTxt}`, { status: 502 });
    }

    const data = await zendeskRes.json();
    return new Response(JSON.stringify({ ok: true, createdTicketId: data?.ticket?.id ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (e: any) {
    return new Response(`Error: ${e?.message || e}`, { status: 500 });
  }
}

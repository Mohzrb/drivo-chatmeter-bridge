// api/review-intake.js
// Unified intake → Zendesk (idempotent). Includes NPS + customer email.
// Subject format: "<Location Name> — <Rating/5>"

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const {
      ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL,
      ZENDESK_API_TOKEN,
      ZENDESK_BRAND_ID,
      ZENDESK_GROUP_ID,
      ZENDESK_REQUESTER_EMAIL
    } = process.env;

    if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) {
      return res.status(400).json({ ok: false, error: "Missing Zendesk envs" });
    }

    const zAuth = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const platform = pick(body.platform, body.source, body.provider, "unknown").toLowerCase();
    const reviewId =
      pick(body.id, body.review_id, body.reviewId, body?.review?.id, body?.review?.review_id, null);
    if (!reviewId) return res.status(400).json({ ok: false, error: "Missing review id" });

    const rating = numOrNull(pick(body.rating, body.score, body.stars));
    const authorName = pick(body?.author?.name, body.author_name, body?.user?.name, body.reviewer, "Unknown Reviewer");
    const content = pick(body.content, body.text, body.comment, "(no content)");
    const reviewUrl = pick(body.url, body.link, body.review_url, null);
    const locationName = pick(body?.location?.name, body.location_name, body.location, body.store, "Unknown Location");
    const createdAt = pick(body.createdAt, body.created_at, body.time, body.timestamp, new Date().toISOString());

    const npsScore = numOrNull(body?.nps?.score);
    const npsCategory = (body?.nps?.category || body?.nps?.type || "").toString().toLowerCase() || null;

    const custEmail = pick(body?.customer?.email, body.email, body.customer_email, null);
    const custName = pick(body?.customer?.name, body.name, (custEmail ? custEmail.split("@")[0] : null), "Guest");

    // idempotency
    const extId = `chatmeter:${platform}:${reviewId}`;
    const idemKey = extId;

    // de-dup by external_id
    const search = await zGetJSON(
      `${zBase}/search.json?query=${encodeURIComponent(`type:ticket external_id:"${extId}"`)}`,
      { Authorization: zAuth }
    );
    if (search?.results?.length) {
      const t = search.results[0];
      return res.status(200).json({ ok: true, status: "exists", ticket_id: t.id, external_id: extId });
    }

    // subject per your request
    const ratingTxt = rating != null ? `${rating}/5` : "Review";
    const subject = `${locationName} — ${ratingTxt}`;

    const lines = [];
    lines.push(`Platform: ${cap(platform)}`);
    if (rating != null) lines.push(`Rating: ${rating}/5`);
    if (npsScore != null || npsCategory) lines.push(`NPS: ${npsScore != null ? npsScore : "(n/a)"}${npsCategory ? ` (${npsCategory})` : ""}`);
    lines.push(`Author: ${authorName}`);
    if (custEmail) lines.push(`Customer Email: ${custEmail}`);
    lines.push(`Location: ${locationName}`);
    lines.push(`Created At: ${createdAt}`);
    if (reviewUrl) lines.push(`Link: ${reviewUrl}`);
    lines.push("");
    lines.push("----- Review Text -----");
    lines.push(content);

    const requester =
      isEmail(custEmail) ? { name: custName, email: custEmail }
      : (isEmail(ZENDESK_REQUESTER_EMAIL) ? { name: "Reviews Bot", email: ZENDESK_REQUESTER_EMAIL } : undefined);

    const ticketPayload = {
      ticket: {
        subject,
        external_id: extId,
        comment: { body: lines.join("\n"), public: true },
        tags: ["chatmeter", "review", sanitize(platform), sanitize(locationName)],
        ...(ZENDESK_BRAND_ID ? { brand_id: toNum(ZENDESK_BRAND_ID) } : {}),
        ...(ZENDESK_GROUP_ID ? { group_id: toNum(ZENDESK_GROUP_ID) } : {}),
        ...(requester ? { requester } : {})
      }
    };

    const createResp = await fetch(`${zBase}/tickets.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: zAuth,
        "Idempotency-Key": idemKey
      },
      body: JSON.stringify(ticketPayload)
    });

    if (!createResp.ok) {
      const txt = await createResp.text();
      return res.status(createResp.status).json({ ok: false, where: "create_ticket", detail: txt });
    }

    const created = await createResp.json();
    return res.status(201).json({ ok: true, status: "created", ticket_id: created?.ticket?.id, external_id: extId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

// helpers
function pick(...vals) { for (const v of vals) { if (v !== undefined && v !== null && String(v).trim() !== "") return v; } return null; }
function numOrNull(x){ if(x===undefined||x===null||x==="") return null; const n=Number(x); return Number.isFinite(n)?n:null; }
function isEmail(x){ return !!x && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x)); }
function sanitize(s){ return String(s||"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"").slice(0,60)||"unknown"; }
function cap(s){ s=String(s||""); return s.charAt(0).toUpperCase()+s.slice(1); }
function toNum(x){ const n=Number(x); return Number.isFinite(n)?n:undefined; }
async function zGetJSON(url, headers){ const r=await fetch(url,{headers}); if(!r.ok) return null; return r.json(); }

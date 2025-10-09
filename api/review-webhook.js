// /api/review-webhook.js
// Chatmeter -> Zendesk: create/update ticket with ONE INTERNAL card.
// If incoming text is empty/boolean/junk, fetch Chatmeter review detail to extract proper text.
// Stable external_id prevents duplicate tickets across subsequent syncs.

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  isBooleanString,
  normalizeProvider,
  pickCustomerContact,
} from "./_helpers.js";

/** Try multiple ID/path variants to retrieve review detail (handles ReviewBuilder path too) */
async function fetchReviewDetailSmart({ id, chmBase, token, accountId }) {
  if (!id || !token) return null;
  const headers = { Authorization: token };
  const idStr = String(id);

  const paths = [
    `/reviews/${encodeURIComponent(idStr)}`,
    `/reviewBuilder/reviews/${encodeURIComponent(idStr)}`,
  ];

  for (const p of paths) {
    const url =
      `${chmBase}${p}` + (accountId ? `?accountId=${encodeURIComponent(accountId)}` : "");
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      try { return JSON.parse(t); } catch { return {}; }
    } catch { /* try next */ }
  }
  return null;
}

/** Heuristic to reject "junk" comments: booleans, ids, tokens, urls, dates, ratings */
function isJunkComment(s) {
  if (!isNonEmptyString(s)) return true;
  const t = s.trim();

  // obvious skips
  if (isBooleanString(t)) return true;                              // true / false
  if (/^https?:\/\//i.test(t)) return true;                         // URL only
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return true;                   // ISO date
  if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return true;                   // 5 or 4.0
  if (/^★{1,5}$/.test(t)) return true;                              // ★★★★★
  if (/^[0-9]+\/[0-9]+$/.test(t)) return true;                      // 4/5

  // obvious id/token patterns (24+ hex, uuid, long base64-like, no spaces long string)
  if (/^[A-Fa-f0-9]{24,}$/.test(t)) return true;                    // hex id (mongo-like)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return true; // UUID
  if (/^[A-Za-z0-9+/_-]{24,}$/.test(t) && !/\s/.test(t)) return true; // token-ish long string
  if (t.length > 20 && !/\s/.test(t)) return true;                  // very long single token

  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL,
    ZENDESK_API_TOKEN,
    ZD_FIELD_REVIEW_ID,
    ZD_FIELD_LOCATION_ID,
    ZD_FIELD_RATING,
    ZD_FIELD_FIRST_REPLY_SENT, // not used here; retained for compatibility
    ZD_FIELD_LOCATION_NAME,    // optional
    CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
    CHATMETER_V5_TOKEN,
    CHM_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "",
  } = process.env;

  const missing = [
    !ZENDESK_SUBDOMAIN && "ZENDESK_SUBDOMAIN",
    !ZENDESK_EMAIL && "ZENDESK_EMAIL",
    !ZENDESK_API_TOKEN && "ZENDESK_API_TOKEN",
    !ZD_FIELD_REVIEW_ID && "ZD_FIELD_REVIEW_ID",
    !ZD_FIELD_LOCATION_ID && "ZD_FIELD_LOCATION_ID",
    !ZD_FIELD_RATING && "ZD_FIELD_RATING",
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).send(`Missing env: ${missing.join(", ")}`);
  }

  try {
    const inBody = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Prefer providerReviewId for stability; fallback to id/reviewId
    const rawProviderReviewId = inBody.providerReviewId || inBody.provider_review_id;
    const rawId               = inBody.id || inBody.reviewId;
    const stableReviewKey     = String(rawProviderReviewId || rawId || "");

    // Still carry individual values for fields
    const reviewId     = rawId || rawProviderReviewId || ""; // for custom field display
    const provider     = normalizeProvider(inBody.provider || inBody.contentProvider || "");
    const locationId   = String(inBody.locationId || "");
    const locationName = String(inBody.locationName || "");
    const rating       = Number(inBody.rating || 0);
    const createdAt    = inBody.createdAt || inBody.reviewDate || new Date().toISOString();
    const authorName   = inBody.authorName || inBody.reviewerUserName || inBody.reviewer || "";
    const publicUrl    = inBody.publicUrl || inBody.reviewURL || inBody.portalUrl || "";
    const contactIn    = pickCustomerContact(inBody); // { email, phone }

    // ---- comment text (fixes boolean/junk + list-API gaps via detail fetch) ----
    let comment = isNonEmptyString(inBody.text) ? inBody.text.trim() : "";
    if (!comment || isJunkComment(comment)) {
      const det = await fetchReviewDetailSmart({
        id: stableReviewKey || reviewId,
        chmBase: CHATMETER_V5_BASE,
        token: CHATMETER_V5_TOKEN,
        accountId: CHM_ACCOUNT_ID,
      });
      if (det) {
        const extracted = getProviderComment(provider, det);
        if (isNonEmptyString(extracted) && !isJunkComment(extracted)) {
          comment = extracted.trim();
        }
        // Backfill contact if missing
        if (!contactIn.email && isNonEmptyString(det.reviewerEmail)) {
          inBody.authorEmail = det.reviewerEmail;
        }
        if (!contactIn.phone && isNonEmptyString(det.reviewerPhone)) {
          inBody.authorPhone = det.reviewerPhone;
        }
      }
    }

    // Final fallback
    if (!isNonEmptyString(comment) || isJunkComment(comment)) {
      comment = ""; // will render "(no text)" in the note
    }

    const contact = {
      email: inBody.authorEmail || contactIn.email || "",
      phone: inBody.authorPhone || contactIn.phone || "",
    };

    // ---- Zendesk helpers ----
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth  = "Basic " + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
    const zGet  = (path) => fetch(`${zBase}${path}`, {
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    });
    const zSend = (path, method, payload) => fetch(`${zBase}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    // ---- De-dupe by stable external_id (prevents duplicate tickets) ----
    const external_id = `chatmeter:${stableReviewKey || reviewId}`;
    const q = encodeURIComponent(`type:ticket external_id:"${external_id}"`);
    const dupRes = await zGet(`/search.json?query=${q}`);
    if (!dupRes.ok) {
      const t = await dupRes.text();
      return res.status(400).send(`Zendesk lookup failed: ${dupRes.status}\n${t}`);
    }
    const dupJson = await dupRes.json();
    let ticketId = dupJson?.results?.[0]?.id || null;

    // ---- Custom fields ----
    const custom_fields = [
      { id: +ZD_FIELD_REVIEW_ID,   value: String(reviewId || stableReviewKey || "") },
      { id: +ZD_FIELD_LOCATION_ID, value: String(locationId || "") },
      { id: +ZD_FIELD_RATING,      value: rating || 0 },
    ];
    if (ZD_FIELD_LOCATION_NAME) {
      custom_fields.push({ id: +ZD_FIELD_LOCATION_NAME, value: locationName || "" });
    }

    // ---- Build INTERNAL note (exact structure) ----
    const note = buildInternalNote({
      dt: createdAt,
      customerName: authorName,
      customerEmail: contact.email,
      customerPhone: contact.phone,
      provider,
      locationName,
      locationId,
      rating,
      comment,
      viewUrl: publicUrl,
    });

    const requesterEmail = "reviews@drivo.com";
    const tags = ["chatmeter", (provider || "chatmeter").toLowerCase(), `cmrvw_${stableReviewKey || reviewId}`];

    if (!ticketId) {
      // Create new ticket
      const payload = {
        ticket: {
          subject: `${locationName || "Location"} – ${"★".repeat(Math.max(0, Math.min(5, rating)))} – ${authorName || "Reviewer"}`,
          requester: { email: requesterEmail, name: requesterEmail },
          external_id,
          tags,
          custom_fields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets.json`, "POST", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk create failed: ${r.status}\n${t}`);
      const j = JSON.parse(t);
      return res.status(200).json({ ok: true, action: "created", id: j?.ticket?.id, externalId: external_id });
    } else {
      // Update existing ticket (append one INTERNAL note)
      const payload = {
        ticket: {
          external_id,
          tags,
          custom_fields,
          comment: { body: note, public: false },
        },
      };
      const r = await zSend(`/tickets/${ticketId}.json`, "PUT", payload);
      const t = await r.text();
      if (!r.ok) return res.status(400).send(`Zendesk update failed: ${r.status}\n${t}`);
      return res.status(200).json({ ok: true, action: "updated", id: ticketId, externalId: external_id });
    }
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

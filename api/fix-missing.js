// /api/fix-missing.js
// Re-scan recent Chatmeter tickets in Zendesk and rebuild the INTERNAL note
// using smart detail fetch + helper normalization (works for ReviewBuilder, Google, Yelp, etc.)

import {
  getProviderComment,
  buildInternalNote,
  isNonEmptyString,
  normalizeProvider,
  pickCustomerContact,
} from "./_helpers.js";

/** Try canonical and ReviewBuilder paths for review detail */
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
      `${chmBase}${p}` +
      (accountId ? `?accountId=${encodeURIComponent(accountId)}` : "");
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      if (!r.ok) continue;
      try {
        return JSON.parse(t);
      } catch {
        return {};
      }
    } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  try {
    // --- auth (optional but recommended)
    const want = process.env.CRON_SECRET || "";
    const got =
      req.headers.authorization ||
      req.headers.Authorization ||
      "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // --- env
    const {
      CHATMETER_V5_BASE = "https://live.chatmeter.com/v5",
      CHATMETER_V5_TOKEN,
      CHM_ACCOUNT_ID = process.env.CHM_ACCOUNT_ID || "",
      ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL,
      ZENDESK_API_TOKEN,
      ZD_FIELD_REVIEW_ID,
      ZD_FIELD_LOCATION_ID,
      ZD_FIELD_RATING,
      ZD_FIELD_LOCATION_NAME, // optional
    } = process.env;

    const missing = [
      !CHATMETER_V5_TOKEN && "CHATMETER_V5_TOKEN",
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

    // --- inputs
    const minutes = Math.max(5, parseInt(req.query.minutes || "1440", 10));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "200", 10)));
    const sinceISO = new Date(Date.now() - minutes * 60 * 1000)
      .toISOString()
      .slice(0, 19) + "Z";

    // --- Zendesk helpers
    const zBase = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
    const auth =
      "Basic " +
      Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString(
        "base64"
      );
    const zGet = (path) =>
      fetch(`${zBase}${path}`, {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
    const zSend = (path, method, payload) =>
      fetch(`${zBase}${path}`, {
        method,
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

    // --- find recent Chatmeter tickets
    const q = `type:ticket tags:chatmeter created>${sinceISO}`;
    const searchUrl = `/search.json?query=${encodeURIComponent(q)}`;
    const sr = await zGet(searchUrl);
    const st = await sr.text();
    if (!sr.ok) return res.status(400).send(`Zendesk search failed: ${sr.status}\n${st}`);
    const sjson = JSON.parse(st);
    const tickets = (sjson?.results || []).slice(0, limit);

    let checked = 0,
      fixed = 0,
      skipped = 0,
      errors = 0;

    for (const t of tickets) {
      checked++;
      try {
        // fetch full ticket to read custom_fields
        const tr = await zGet(`/tickets/${t.id}.json`);
        const tt = await tr.text();
        if (!tr.ok) {
          skipped++;
          continue;
        }
        const tk = JSON.parse(tt)?.ticket;
        if (!tk) {
          skipped++;
          continue;
        }

        const cf = Array.isArray(tk.custom_fields) ? tk.custom_fields : [];
        const rid = cf.find((f) => String(f.id) === String(ZD_FIELD_REVIEW_ID))?.value;
        const locId = cf.find((f) => String(f.id) === String(ZD_FIELD_LOCATION_ID))?.value;
        const rating = cf.find((f) => String(f.id) === String(ZD_FIELD_RATING))?.value;

        if (!rid) {
          skipped++;
          continue;
        }

        // Fetch review detail (smart paths)
        const det = await fetchReviewDetailSmart({
          id: rid,
          chmBase: CHATMETER_V5_BASE,
          token: CHATMETER_V5_TOKEN,
          accountId: CHM_ACCOUNT_ID,
        });
        if (!det) {
          skipped++;
          continue;
        }

        // Normalize
        const provider = normalizeProvider(det?.contentProvider || det?.provider || "");
        const contact = pickCustomerContact(det);
        const text = getProviderComment(provider, det); // filters junk automatically
        const locationName = det?.locationName || tk?.subject || "";
        const authorName = det?.reviewerUserName || det?.reviewer || "";

        const note = buildInternalNote({
          dt: det?.reviewDate || det?.createdAt || "",
          customerName: authorName,
          customerEmail: contact.email,
          customerPhone: contact.phone,
          provider,
          locationName: locationName,
          locationId: String(det?.locationId || locId || ""),
          rating: Number(det?.rating || rating || 0),
          comment: text,
          viewUrl: det?.reviewURL || det?.publicUrl || det?.portalUrl || "",
        });

        // Append corrected INTERNAL note
        const upd = await zSend(`/tickets/${t.id}.json`, "PUT", {
          ticket: {
            comment: { body: note, public: false },
            custom_fields: [
              { id: +ZD_FIELD_REVIEW_ID, value: String(rid) },
              { id: +ZD_FIELD_LOCATION_ID, value: String(det?.locationId || locId || "") },
              { id: +ZD_FIELD_RATING, value: Number(det?.rating || rating || 0) },
              ...(ZD_FIELD_LOCATION_NAME
                ? [{ id: +ZD_FIELD_LOCATION_NAME, value: String(locationName || "") }]
                : []),
            ],
          },
        });
        if (!upd.ok) {
          errors++;
          continue;
        }

        fixed++;
      } catch {
        errors++;
      }
    }

    return res
      .status(200)
      .json({ ok: true, since: sinceISO, checked, fixed, skipped, errors });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

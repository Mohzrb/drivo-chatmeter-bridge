import { json, bearer } from "./_helpers.js";
import {
  fetchReviewsFlexible,
  getAuth,
  buildReviewsUrl
} from "../lib/chatmeter.js";
import {
  findOrCreateTicketByExternalId,
  addInternalNote,
  getTicketAudits
} from "../lib/zendesk.js";
import { normalizeReview } from "../lib/schema.js";
import { commentExists } from "../lib/dedupe.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    // Protect with CRON_SECRET
    const tok = bearer(req);
    if (!process.env.CRON_SECRET || tok !== process.env.CRON_SECRET) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    // Inputs
    const minutes = Math.max(
      1,
      parseInt(req.query.minutes || process.env.POLLER_LOOKBACK_MINUTES || "60", 10)
    );
    const max = Math.max(1, parseInt(req.query.max || "20", 10));
    const dry = (req.query.dry ?? "1") !== "0"; // default = DRY RUN
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Build diagnostics (which URL/auth are being used)
    let urlUsed = null;
    let authStyle = process.env.CHATMETER_AUTH_STYLE || "bearer";
    let authDiag = {};

    try {
      const auth = await getAuth(); // may login or use token env
      urlUsed = buildReviewsUrl(auth.base, sinceIso, max);
      authDiag = {
        base: auth.base,
        tokenPresent: !!auth.token,
        cookiePresent: !!auth.cookie,
        authStyle
      };
    } catch (e) {
      return json(res, 200, {
        ok: false,
        stage: "auth",
        error: String(e?.message || e)
      });
    }

    // Pull reviews (flexible client handles header style & URL overrides)
    let raw = [];
    try {
      raw = await fetchReviewsFlexible(sinceIso, max);
    } catch (e) {
      return json(res, 200, {
        ok: false,
        stage: "chatmeter",
        urlUsed,
        auth: authDiag,
        error: String(e?.message || e)
      });
    }

    // Normalize
    const reviews = raw.map(normalizeReview);

    // DRY RUN: only report what would happen
    if (dry) {
      return json(res, 200, {
        ok: true,
        mode: "dry",
        sinceIso,
        urlUsed,
        auth: authDiag,
        checked: reviews.length,
        sampleKeys: reviews[0] ? Object.keys(reviews[0]) : null,
        sample: reviews[0] || null,
        hint: "Set dry=0 to write to Zendesk once count/sample look correct."
      });
    }

    // LIVE mode: create/update tickets + dedup internal notes
    let posted = 0, skipped = 0, errors = 0;
    for (const r of reviews) {
      try {
        if (!r?.id) { skipped++; continue; }

        const { id: ticketId } = await findOrCreateTicketByExternalId(r);

        const body = [
          `Provider: ${r.source}`,
          `Rating: ${r.rating}`,
          r.url ? `URL: ${r.url}` : null,
          "",
          r.content || "(no text)"
        ]
          .filter(Boolean)
          .join("\n");

        const audits = await getTicketAudits(ticketId);
        if (commentExists(audits, body)) { skipped++; continue; }

        await addInternalNote(ticketId, body);
        posted++;
      } catch {
        errors++;
      }
    }

    return json(res, 200, {
      ok: true,
      mode: "live",
      sinceIso,
      urlUsed,
      checked: reviews.length,
      posted,
      skipped,
      errors
    });
  } catch (e) {
    return json(res, 500, { ok: false, stage: "handler", error: String(e?.message || e) });
  }
}

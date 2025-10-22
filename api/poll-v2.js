import { json, bearer } from "./_helpers.js";
import { fetchReviewsSince } from "../lib/chatmeter.js";
import {
  findOrCreateTicketByExternalId,
  addInternalNote,
  getTicketAudits
} from "../lib/zendesk.js";
import { commentExists } from "../lib/dedupe.js";

export default async function handler(req, res) {
  try {
    // Allow only GET requests
    if (req.method !== "GET")
      return json(res, 405, { ok: false, error: "Method Not Allowed" });

    // Validate CRON_SECRET
    const b = bearer(req);
    if (!process.env.CRON_SECRET || b !== process.env.CRON_SECRET) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    // Query params
    const minutes = Math.max(
      1,
      parseInt(req.query.minutes || process.env.POLLER_LOOKBACK_MINUTES || "60", 10)
    );
    const max = Math.max(1, parseInt(req.query.max || "25", 10));
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Pull recent reviews
    const reviews = await fetchReviewsSince(sinceIso, max);
    let posted = 0,
      skipped = 0,
      errors = 0;

    for (const r of reviews) {
      try {
        const { id: ticketId } = await findOrCreateTicketByExternalId(r);

        // Build the internal note
        const lines = [
          `Provider: ${r.source}`,
          `Rating: ${r.rating}`,
          r.url ? `URL: ${r.url}` : null,
          "",
          r.content || "(no text)"
        ].filter(Boolean);
        const body = lines.join("\n");

        // Check for duplicates
        const audits = await getTicketAudits(ticketId);
        if (commentExists(audits, body)) {
          skipped++;
          continue;
        }

        // Post note
        await addInternalNote(ticketId, body);
        posted++;
      } catch (e) {
        errors++;
      }
    }

    return json(res, 200, {
      ok: true,
      checked: reviews.length,
      posted,
      skipped,
      errors,
      sinceIso
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

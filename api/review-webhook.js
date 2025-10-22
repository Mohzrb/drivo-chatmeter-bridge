import { json } from "./_helpers.js";
import { normalizeReview } from "../lib/schema.js";
import {
  findOrCreateTicketByExternalId,
  addInternalNote,
  getTicketAudits
} from "../lib/zendesk.js";
import { commentExists } from "../lib/dedupe.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return json(res, 405, { ok: false, error: "Method Not Allowed" });

    // Optional shared secret for inbound webhooks
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (process.env.WEBHOOK_SECRET && bearer !== process.env.WEBHOOK_SECRET) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    const raw = req.body?.review || req.body;
    if (!raw) return json(res, 400, { ok: false, error: "Missing review in body" });

    const r = normalizeReview(raw);
    if (!r.id) return json(res, 400, { ok: false, error: "Missing review id after normalization" });

    const { id: ticketId } = await findOrCreateTicketByExternalId(r);

    const body = [
      `Provider: ${r.source}`,
      `Rating: ${r.rating}`,
      r.url ? `URL: ${r.url}` : null,
      "",
      r.content || "(no text)"
    ].filter(Boolean).join("\n");

    const audits = await getTicketAudits(ticketId);
    if (!commentExists(audits, body)) {
      await addInternalNote(ticketId, body);
    }

    return json(res, 200, { ok: true, ticketId });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

export default async function handler(req, res) {
  const send = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
  try {
    if (req.method !== "POST") return send(405, { ok:false, error:"Method Not Allowed" });

    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!process.env.WEBHOOK_SECRET || bearer !== process.env.WEBHOOK_SECRET) {
      return send(401, { ok:false, error:"Unauthorized" });
    }

    const body = (typeof req.body === "string") ? JSON.parse(req.body) : (req.body || {});
    const raw = body.review || body || {};

    // --- normalize a minimal shape ---
    const normalize = (r) => ({
      id: String(r.id || r.reviewId),
      source: (r.source || r.provider || r.contentProvider || "").toString().toLowerCase(),
      rating: Number(r.rating || r.stars || 0),
      url: r.url || r.permalink || r.reviewUrl || null,
      content: r.content || r.text || r.comment || "",
      author: r.authorName || r.reviewerUserName || r.user || "Unknown",
      locationId: String(r.locationId || r.location_id || ""),
      createdAt: r.createdAt || r.reviewDate || r.created_at || new Date().toISOString(),
      title: r.title || ""
    });

    const review = normalize(raw);
    if (!review.id) return send(200, { ok:false, error:"Missing review id" });

    // dynamic import to avoid cold-start crashes
    const zd = await import("../lib/zendesk.js");
    const dedupe = await import("../lib/dedupe.js");

    // Create/find ticket
    const { id: ticketId } = await zd.findOrCreateTicketByExternalId(review);

    // Build internal note
    const note = [
      `Provider: ${review.source}`,
      `Rating: ${review.rating}`,
      review.url ? `URL: ${review.url}` : null,
      "",
      review.content || "(no text)"
    ].filter(Boolean).join("\n");

    // Dedupe comment
    const audits = await zd.getTicketAudits(ticketId);
    if (!dedupe.commentExists(audits, note)) {
      await zd.addInternalNote(ticketId, note);
    }

    return send(200, { ok:true, ticketId, received: review.id });
  } catch (e) {
    return send(500, { ok:false, error:String(e?.message || e) });
  }
}

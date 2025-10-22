// poll-v2 with safe dynamic imports + full diagnostics (DRY by default)
export default async function handler(req, res) {
  // tiny response helper (avoid importing _helpers)
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };

  try {
    // 1) Method check
    if (req.method !== "GET") {
      return send(405, { ok: false, error: "Method Not Allowed" });
    }

    // 2) Read CRON secret (manual to avoid importing _helpers)
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cron = process.env.CRON_SECRET || "";
    if (!cron || bearer !== cron) {
      return send(401, { ok: false, error: "Unauthorized" });
    }

    // Inputs
    const minutes = Math.max(1, parseInt(req.query.minutes || "60", 10));
    const max     = Math.max(1, parseInt(req.query.max || "20", 10));
    const dry     = (req.query.dry ?? "1") !== "0"; // DRY by default
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // 3) Dynamically import flexible Chatmeter client
    let cm;
    try {
      cm = await import("../lib/chatmeter.js");
    } catch (e) {
      return send(200, {
        ok: false,
        stage: "import-chatmeter",
        error: String(e?.message || e)
      });
    }

    // 4) Acquire auth + compute URL (diagnostics only)
    let authInfo, urlUsed, authDiag;
    try {
      authInfo = await cm.getAuth(); // may login or use token envs
      urlUsed  = cm.buildReviewsUrl(authInfo.base, sinceIso, max);
      authDiag = {
        base: authInfo.base,
        tokenPresent: !!authInfo.token,
        cookiePresent: !!authInfo.cookie,
        authStyle: process.env.CHATMETER_AUTH_STYLE || "bearer"
      };
    } catch (e) {
      return send(200, { ok: false, stage: "auth", error: String(e?.message || e) });
    }

    // 5) Fetch reviews via flexible client
    let raw = [];
    try {
      raw = await cm.fetchReviewsFlexible(sinceIso, max);
    } catch (e) {
      return send(200, {
        ok: false,
        stage: "chatmeter",
        urlUsed,
        auth: authDiag,
        error: String(e?.message || e)
      });
    }

    // 6) Normalize (dynamic import to avoid early crashes)
    let normalizeReview;
    try {
      const schema = await import("../lib/schema.js");
      normalizeReview = schema.normalizeReview;
    } catch (e) {
      return send(200, { ok: false, stage: "import-schema", error: String(e?.message || e) });
    }

    const reviews = raw.map(normalizeReview);

    // DRY mode: show preview + diagnostics only
    if (dry) {
      return send(200, {
        ok: true,
        mode: "dry",
        sinceIso,
        urlUsed,
        auth: authDiag,
        checked: reviews.length,
        sampleKeys: reviews[0] ? Object.keys(reviews[0]) : null,
        sample: reviews[0] || null,
        hint: "Add &dry=0 to post into Zendesk once this looks good."
      });
    }

    // 7) LIVE mode: dynamic import Zendesk helpers only here
    let zd, dedupe;
    try {
      zd = await import("../lib/zendesk.js");
      dedupe = await import("../lib/dedupe.js");
    } catch (e) {
      return send(200, { ok: false, stage: "import-zendesk", error: String(e?.message || e) });
    }

    let posted = 0, skipped = 0, errors = 0;
    for (const r of reviews) {
      try {
        if (!r?.id) { skipped++; continue; }

        const { id: ticketId } = await zd.findOrCreateTicketByExternalId(r);

        const body = [
          `Provider: ${r.source}`,
          `Rating: ${r.rating}`,
          r.url ? `URL: ${r.url}` : null,
          "",
          r.content || "(no text)"
        ].filter(Boolean).join("\n");

        const audits = await zd.getTicketAudits(ticketId);
        if (dedupe.commentExists(audits, body)) { skipped++; continue; }

        await zd.addInternalNote(ticketId, body);
        posted++;
      } catch {
        errors++;
      }
    }

    return send(200, {
      ok: true,
      mode: "live",
      sinceIso,
      urlUsed,
      checked: reviews.length,
      posted, skipped, errors
    });
  } catch (e) {
    return send(500, { ok: false, stage: "top-catch", error: String(e?.message || e) });
  }
}

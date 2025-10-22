import { json, bearer } from "./_helpers.js";
import { commentExists } from "../lib/dedupe.js";

// ⚠️ Debug version: talks to Chatmeter directly first; optional "dry" mode skips Zendesk
export default async function handler(req, res) {
  try {
    if (req.method !== "GET")
      return json(res, 405, { ok: false, error: "Method Not Allowed" });

    // CRON_SECRET guard
    const b = bearer(req);
    if (!process.env.CRON_SECRET || b !== process.env.CRON_SECRET) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    // -------- presence check (helps us debug env on prod) ----------
    const presence = {
      CHATMETER_V5_BASE: !!process.env.CHATMETER_V5_BASE,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      CHATMETER_TOKEN: !!process.env.CHATMETER_TOKEN,
      CHATMETER_API_KEY: !!process.env.CHATMETER_API_KEY,
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN
    };

    // -------- inputs ----------
    const minutes = Math.max(
      1,
      parseInt(req.query.minutes || process.env.POLLER_LOOKBACK_MINUTES || "60", 10)
    );
    const max = Math.max(1, parseInt(req.query.max || "25", 10));
    const dry = (req.query.dry ?? "1") !== "0"; // default DRY RUN (no Zendesk writes) until we confirm Chatmeter

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // -------- Chatmeter call (raw) ----------
    const base = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const token =
      process.env.CHATMETER_V5_TOKEN ||
      process.env.CHATMETER_TOKEN ||
      process.env.CHATMETER_API_KEY ||
      "";

    if (!token) {
      return json(res, 200, {
        ok: false,
        stage: "env",
        presence,
        error: "Missing Chatmeter token (CHATMETER_V5_TOKEN/CHATMETER_TOKEN/CHATMETER_API_KEY)"
      });
    }

    const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`;

    let status = null, text = null, data = null;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store"
      });
      status = r.status;
      text = await r.text().catch(() => "");
      try { data = JSON.parse(text); } catch { data = null; }
    } catch (err) {
      return json(res, 200, {
        ok: false, stage: "chatmeter-fetch", presence, error: String(err?.message || err)
      });
    }

    // If Chatmeter doesn’t return OK, show us the body
    if (status < 200 || status >= 300) {
      return json(res, 200, {
        ok: false,
        stage: "chatmeter-http",
        presence,
        status,
        url,
        bodyPreview: (text || "").slice(0, 2000)
      });
    }

    // Normalize array
    const arr = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data) ? data : [];

    // If dry, stop here and return sample so we see the payload shape
    if (dry) {
      return json(res, 200, {
        ok: true,
        mode: "dry",
        presence,
        sinceIso,
        checked: arr.length,
        sample: arr[0] ? Object.keys(arr[0]) : null
      });
    }

    // ---------- REAL ZENDESK FLOW (runs only with &dry=0) ----------
    // Lazy import to avoid crashes before Chatmeter passes
    const { default: normalizeMod } = await import("../lib/schema.js");
    const { normalizeReview } = normalizeMod || {};
    const zd = await import("../lib/zendesk.js");
    const { findOrCreateTicketByExternalId, addInternalNote, getTicketAudits } = zd;

    let posted = 0, skipped = 0, errors = 0;
    for (const raw of arr) {
      try {
        const r = normalizeReview ? normalizeReview(raw) : raw;
        if (!r?.id) { skipped++; continue; }

        const { id: ticketId } = await findOrCreateTicketByExternalId(r);

        const body = [
          `Provider: ${r.source}`,
          `Rating: ${r.rating}`,
          r.url ? `URL: ${r.url}` : null,
          "",
          r.content || "(no text)"
        ].filter(Boolean).join("\n");

        const audits = await getTicketAudits(ticketId);
        if (commentExists(audits, body)) { skipped++; continue; }

        await addInternalNote(ticketId, body);
        posted++;
      } catch (e) {
        errors++;
      }
    }

    return json(res, 200, {
      ok: true,
      mode: "live",
      sinceIso,
      checked: arr.length,
      posted, skipped, errors
    });

  } catch (e) {
    return json(res, 500, { ok: false, stage: "handler", error: String(e?.message || e) });
  }
}

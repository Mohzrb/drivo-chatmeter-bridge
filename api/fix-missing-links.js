import {
  getLocEntry, getGlobalEntry,
  yelpUrlFromAlias, googleReviewsUrlFromConfig,
  trustpilotUrlFromConfig
} from "../src/integrations/providers.js";

export default async function handler(req, res) {
  try {
    const want = process.env.CRON_SECRET;
    const got  = req.headers.authorization || "";
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const ZD_SUB   = process.env.ZENDESK_SUBDOMAIN;
    const ZD_EMAIL = process.env.ZENDESK_EMAIL;
    const ZD_TOK   = process.env.ZENDESK_API_TOKEN;
    const F_REVIEW = process.env.ZD_FIELD_REVIEW_ID;
    if (!ZD_SUB || !ZD_EMAIL || !ZD_TOK || !F_REVIEW) {
      return res.status(500).send("Missing required Zendesk envs.");
    }

    const minutes = +(req.query.minutes || 1440); // 24h
    const limit   = +(req.query.limit || 200);
    const sinceISO = new Date(Date.now() - minutes*60*1000).toISOString().slice(0,19)+"Z";
    const auth = "Basic " + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOK}`).toString("base64");

    const q = `type:ticket tags:chatmeter created>${sinceISO}`;
    const searchUrl = `https://${ZD_SUB}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(q)}`;
    const search = await jf(searchUrl, { headers: { Authorization: auth } });
    const tickets = (search?.results || []).slice(0, limit);

    const globalEntry = getGlobalEntry();
    let checked = 0, patched = 0, skipped = 0, errors = 0;

    for (const t of tickets) {
      checked++;
      try {
        const tr = await jf(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
          headers: { Authorization: auth }
        });
        const tk = tr?.ticket;
        if (!tk) { skipped++; continue; }

        const providerTag = (tk.tags || []).find(z => z && z.toLowerCase() !== "chatmeter") || "";
        const provider = providerTag.toUpperCase();
        if (!["YELP", "GOOGLE", "TRUSTPILOT"].includes(provider)) { skipped++; continue; }

        const rid = (tk.custom_fields || []).find(f => String(f.id) === String(F_REVIEW))?.value;
        if (!rid) { skipped++; continue; }

        const aud = await jf(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}/comments.json?include=users`, {
          headers: { Authorization: auth }
        });
        const firstPrivate = (aud?.comments || []).find(c => c.public === false);
        const body = (firstPrivate?.html_body || firstPrivate?.body || "");
        const hasText = /<strong>Comment:<\/strong><br>(?!\s*\(no text\))/i.test(body) || /Comment:\s*(?!\(no text\))/i.test(body);
        if (hasText) { skipped++; continue; }

        // locationId from custom field or "(123456789)" in the HTML line
        let locationId = "";
        const locField = tk.custom_fields?.find(f => /\blocation_id\b/i.test(String(f.id)));
        if (locField?.value) locationId = String(locField.value);
        if (!locationId) {
          const m = body.match(/\((\d{9,})\)\s*<\/div>/) || body.match(/\((\d{9,})\)/);
          if (m) locationId = m[1];
        }

        const entry = getLocEntry(locationId);
        let link = null, aliasInfo = null;

        switch (provider) {
          case "YELP":
            link = yelpUrlFromAlias(entry?.yelp);
            aliasInfo = entry?.yelp ? `Business (alias): ${entry.yelp}` : null;
            break;
          case "GOOGLE":
            link = googleReviewsUrlFromConfig(entry);
            break;
          case "TRUSTPILOT":
            link = trustpilotUrlFromConfig(entry, globalEntry);
            break;
        }

        if (!link) { skipped++; continue; }

        const note = [
          `${provider} Backfill`,
          "",
          "Provider restricts automated comment retrieval.",
          "Use the link below to view the review text directly:",
          link,
          "",
          aliasInfo
        ].filter(Boolean).join("\n");

        await fetch(`https://${ZD_SUB}.zendesk.com/api/v2/tickets/${t.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ ticket: { comment: { body: note, public: false } } })
        });

        patched++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({ ok: true, since: sinceISO, checked, patched, skipped, errors });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

async function jf(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  try { return JSON.parse(t); } catch { return {}; }
}

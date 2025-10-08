// poller-v2 (ultra-safe): dry-run, max cap, robust parsing, no enrichment
export default async function handler(req, res) {
  const VERSION = "poller-v2-ultrasafe-2025-10-07";
  try {
    // Optional auth
    const want = process.env.CRON_SECRET;
    const got = (req.headers?.authorization || req.headers?.Authorization || "").trim();
    if (want && got !== `Bearer ${want}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized", version: VERSION });
    }

    // Required env
    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;        // raw token
    const SELF_BASE = process.env.SELF_BASE_URL;             // e.g., https://drivo-chatmeter-bridge.vercel.app
    if (!CHM_TOKEN || !SELF_BASE) {
      return res.status(500).json({ ok: false, error: "Missing env: CHATMETER_V5_TOKEN or SELF_BASE_URL", version: VERSION });
    }

    // Parse query
    const baseForURL = `https://${req?.headers?.host || "x.local"}`;
    const u = new URL(req.url || "/api/poll-v2", baseForURL);

    const minutes = Number(u.searchParams.get("minutes") || process.env.POLLER_LOOKBACK_MINUTES || 15);
    const clientId  = u.searchParams.get("clientId")  || process.env.CHM_CLIENT_ID  || "";
    const accountId = u.searchParams.get("accountId") || process.env.CHM_ACCOUNT_ID || "";
    const groupId   = u.searchParams.get("groupId")   || process.env.CHM_GROUP_ID   || "";
    const dry       = ["1","true","yes","on"].includes((u.searchParams.get("dry") || "").toLowerCase());
    const maxItems  = Math.max(1, Math.min(50, Number(u.searchParams.get("max") || 50)));

    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    // Build Chatmeter URL (updatedSince)
    let q = `limit=${maxItems}&sortField=reviewDate&sortOrder=DESC&updatedSince=${encodeURIComponent(sinceIso)}`;
    if (clientId)  q += `&clientId=${encodeURIComponent(clientId)}`;
    if (accountId) q += `&accountId=${encodeURIComponent(accountId)}`;
    if (groupId)   q += `&groupId=${encodeURIComponent(groupId)}`;

    const url = `${CHM_BASE}/reviews?${q}`;

    // Call Chatmeter
    const r = await fetch(url, { headers: { Authorization: CHM_TOKEN } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Chatmeter ${r.status}`, snippet: (txt || "").slice(0, 250), version: VERSION });
    }

    const items = extractItems(txt);
    let posted = 0, skipped = 0, errors = 0;

    // Post to our webhook (unless dry)
    if (!dry) {
      for (const it of items.slice(0, maxItems)) {
        const payload = buildPayload(it);
        if (!payload.id) { skipped++; continue; }
        try {
          const rr = await fetch(`${SELF_BASE}/api/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!rr.ok) { errors++; continue; }
          posted++;
        } catch {
          errors++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      version: VERSION,
      echo: { rawUrl: req.url, minutes, clientId, accountId, groupId, dry, maxItems },
      since: sinceIso,
      checked: items.length,
      posted, skipped, errors,
      debug: { url, body_snippet: (txt || "").slice(0, 300) },
    });

  } catch (e) {
    return res.status(500).json({ ok: false, version: "poller-v2-ultrasafe-2025-10-07", caught: String(e) });
  }
}

/* ---------- helpers ---------- */

function extractItems(txt) {
  try {
    const data = JSON.parse(txt);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.reviews)) return data.reviews; // ReviewBuilder
    if (Array.isArray(data.items))   return data.items;
    return [];
  } catch {
    return [];
  }
}

function buildPayload(it) {
  const id = it?.id ?? it?.reviewId ?? it?.review_id ?? it?.reviewID ?? it?.providerReviewId ?? null;
  const locationId   = it.locationId ?? it.location_id ?? it.providerLocationId ?? "";
  const locationName = it.locationName ?? it.location_name ?? it.location ?? "Unknown";
  const rating       = it.rating ?? it.stars ?? it.score ?? 0;
  const authorName   = it.authorName ?? it.reviewerUserName ?? it.reviewerName ?? it.author ?? "Chatmeter Reviewer";
  const publicUrl    = it.publicUrl ?? it.reviewURL ?? it.url ?? "";
  const createdAt    = it.reviewDate ?? it.createdAt ?? it.date ?? it.createdOn ?? "";
  const text         = extractText(it);

  return {
    id,
    locationId,
    locationName,
    rating,
    authorName,
    createdAt,
    text,
    publicUrl,
    portalUrl: it.portalUrl ?? it.portal_url ?? "",
  };
}

function extractText(it) {
  const out = [];
  const fields = [
    it.text, it.reviewText, it.content, it.comment, it.message,
    it.detail, it.body, it.responseText, it.consumerComment
  ];
  for (const f of fields) if (f) out.push(String(f).trim());

  const rd = it.reviewData || it.data || it.answers || it.fields;
  if (Array.isArray(rd)) {
    for (const row of rd) {
      const name = String(row?.name ?? row?.label ?? row?.question ?? "").toLowerCase();
      const val  = row?.value ?? row?.answer ?? row?.text ?? row?.comment ?? "";
      if (!val) continue;
      if (/(comment|feedback|text|review|message|free|open)/.test(name)) {
        out.push(String(val).trim());
      }
    }
  }
  return out.filter(Boolean).join("\n").trim();
}

export default async function handler(req, res) {
  try {
    const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;            // raw token (no "Bearer")
    const SELF_BASE = process.env.SELF_BASE_URL;                  // e.g. https://drivo-chatmeter-bridge.vercel.app
    const LOOKBACK  = Number(process.env.POLLER_LOOKBACK_MINUTES || 15); // default 15 minutes

    const miss = [
      !CHM_TOKEN && "CHATMETER_V5_TOKEN",
      !SELF_BASE && "SELF_BASE_URL",
    ].filter(Boolean);
    if (miss.length) return res.status(500).send(`Missing env: ${miss.join(", ")}`);

    // since = now - lookback (a small overlap is OK to avoid gaps)
    const since = new Date(Date.now() - LOOKBACK * 60 * 1000).toISOString();

    const url = `${CHM_BASE}/reviews?updatedSince=${encodeURIComponent(since)}&limit=50&sortField=reviewDate&sortOrder=DESC`;
    const r = await fetch(url, { headers: { Authorization: CHM_TOKEN } });

    const txt = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter list error: ${r.status} ${txt}`);
    const data = safeParse(txt, []);
    const items = Array.isArray(data) ? data : (data.results || []);

    let posted = 0, errors = 0;
    for (const it of items) {
      const payload = {
        id: it.id ?? it.reviewId ?? it.review_id,
        locationId: it.locationId ?? "",
        locationName: it.locationName ?? "Unknown",
        rating: it.rating ?? 0,
        authorName: it.authorName ?? "Chatmeter Reviewer",
        createdAt: it.reviewDate ?? it.createdAt ?? "",
        text: it.text ?? "",
        publicUrl: it.publicUrl ?? "",
        portalUrl: it.portalUrl ?? ""
      };

      // Skip if no id
      if (!payload.id) continue;

      try {
        const resp = await fetch(`${SELF_BASE}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) { errors++; continue; }
        posted++;
      } catch {
        errors++;
      }
    }

    return res.status(200).json({ ok: true, checked: items.length, posted, errors, since, lookback_minutes: LOOKBACK });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

function safeParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

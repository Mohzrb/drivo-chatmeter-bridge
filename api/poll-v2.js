// /api/poll-v2.js
// Poll Chatmeter (last N minutes) and forward to /api/review-webhook. Idempotent (webhook dedupes).

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Optional auth (cron)
  const want = process.env.CRON_SECRET;
  const got = req.headers.authorization || "";
  if (want && got !== `Bearer ${want}`) return res.status(401).json({ ok: false, error: "Unauthorized", version: "poller-v2" });

  const CHM_BASE    = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN   = process.env.CHATMETER_V5_TOKEN;
  const ACCT        = process.env.CHM_ACCOUNT_ID;
  const SELF        = process.env.SELF_BASE_URL;
  const MAP_JSON    = process.env.CHM_LOCATION_MAP || "{}";

  const minutes = Number(req.query.minutes || 60);       // default 60 (hourly)
  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const missing = [
    !CHM_TOKEN && "CHATMETER_V5_TOKEN",
    !ACCT && "CHM_ACCOUNT_ID",
    !SELF && "SELF_BASE_URL",
  ].filter(Boolean);
  if (missing.length) return res.status(500).send(`Missing env: ${missing.join(", ")}`);

  const LOC_MAP = safe(() => JSON.parse(MAP_JSON), {});
  const first10 = (s) => (s || "").slice(0, 400); // just for debug snippet

  try {
    const url = `${CHM_BASE}/reviews?limit=50&sortField=reviewDate&sortOrder=DESC&updatedSince=${encodeURIComponent(sinceIso)}&accountId=${encodeURIComponent(ACCT)}`;
    const r   = await fetch(url, { headers: { Authorization: CHM_TOKEN } });
    const tx  = await r.text();
    if (!r.ok) return res.status(502).send(`Chatmeter error: ${r.status} ${tx}`);

    const payload = safe(() => JSON.parse(tx), {});
    const items   = Array.isArray(payload.reviews) ? payload.reviews : [];

    let posted = 0, errors = 0;
    for (const it of items) {
      const id = String(it.id || it.reviewId || it.providerReviewId || "").trim();
      if (!id) continue;

      const locId  = String(it.locationId || "");
      const locNm  = LOC_MAP[locId] || it.locationName || "Unknown";
      const rating = Number(it.rating || 0);
      const createdAt = it.reviewDate || it.createdAt || "";
      const publicUrl = it.reviewURL || it.publicUrl || "";
      const provider  = it.contentProvider || it.provider || "";

      let text = String(it.reviewText || "").trim();
      if (!text && Array.isArray(it.reviewData)) {
        const d = it.reviewData.find(x => /comment|text/i.test(x?.name || ""));
        if (d?.value) text = String(d.value);
      }

      const body = {
        id, provider,
        rating, locationId: locId, locationName: locNm,
        authorName: it.reviewerUserName || "Reviewer",
        createdAt, publicUrl, text
      };

      try {
        const p = await fetch(`${SELF}/api/review-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!p.ok) { errors++; continue; }
        posted++;
      } catch { errors++; }
    }

    return res.status(200).json({
      ok: true,
      since: sinceIso,
      checked: items.length,
      posted, errors,
      debug: { url, body_snippet: first10(tx) }
    });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

function safe(fn, fb) { try { return fn(); } catch { return fb; } }

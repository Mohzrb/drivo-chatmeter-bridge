export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  // Auth with CRON_SECRET
  const want = process.env.CRON_SECRET || '';
  const got  = req.headers.authorization || req.headers.Authorization || '';
  if (want && got !== `Bearer ${want}`) return res.status(401).json({ ok:false, error:'Unauthorized' });

  const CHM_BASE  = process.env.CHATMETER_V5_BASE || 'https://live.chatmeter.com/v5';
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;

  if (!CHM_TOKEN) return res.status(500).json({ ok:false, error:'Missing CHATMETER_V5_TOKEN' });

  // Helpers (same as in poll-v2)
  function isGoodText(v){ if(v==null) return false; const s=String(v).trim(); if(!s) return false; if(/^[a-f0-9]{24}$/i.test(s)) return false; return true; }
  function pickTextFromReview(r){
    const direct = [r.text, r.reviewText, r.comment, r.body, r.content, r.message, r.review_body].find(isGoodText);
    if (isGoodText(direct)) return String(direct).trim();
    const rows = Array.isArray(r.reviewData) ? r.reviewData : (Array.isArray(r.data)?r.data:[]);
    for (const it of rows) {
      const key = String(it.name || it.key || '').toLowerCase();
      const val = it.value ?? it.text ?? it.detail ?? '';
      if (!isGoodText(val)) continue;
      if (/(comment|comments|review|review[_ ]?text|text|body|content|np_comment|free.*text|description)/.test(key)) {
        return String(val).trim();
      }
    }
    return '';
  }
  function pickPublicUrl(r){ return r.publicUrl || r.reviewURL || r.portalUrl || ''; }

  // Query args
  const minutes = Math.max(1, parseInt(req.query.minutes || '1440', 10));
  const limit   = Math.min(500, parseInt(req.query.limit || '200', 10));
  const sinceIso = new Date(Date.now() - minutes*60*1000).toISOString();

  // Pull recent reviews to fix
  const url = `${CHM_BASE}/reviews?limit=${limit}&sortField=reviewDate&sortOrder=DESC&updatedSince=${encodeURIComponent(sinceIso)}`;
  const r = await fetch(url, { headers:{ Authorization: CHM_TOKEN }});
  const txt = await r.text();
  if (!r.ok) return res.status(502).send(txt);

  const body = JSON.parse(txt || '{}');
  const items = Array.isArray(body.reviews) ? body.reviews : (body.results || []);
  let checked=0, fixed=0, skipped=0, errors=0;

  for (const it of items) {
    checked++;
    const id = it.id || it.reviewId || it.review_id;
    if (!id) { skipped++; continue; }

    // If we already have decent text skip; else fetch detail for better data
    let text = pickTextFromReview(it);
    if (!isGoodText(text)) {
      try {
        const dres = await fetch(`${CHM_BASE}/reviews/${encodeURIComponent(id)}`, { headers:{ Authorization: CHM_TOKEN }});
        const dtxt = await dres.text();
        if (dres.ok) {
          const det = JSON.parse(dtxt || '{}');
          text = pickTextFromReview(det);
          it.publicUrl = pickPublicUrl(det) || pickPublicUrl(it);
        }
      } catch {}
    }
    if (!isGoodText(text)) { skipped++; continue; }

    // Call your existing /api/review-webhook in "fix" mode to UPDATE the one internal note
    try {
      const resp = await fetch(`${process.env.SELF_BASE_URL}/api/review-webhook`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          id,
          provider: it.contentProvider || it.provider || '',
          locationId: it.locationId || '',
          rating: it.rating || 0,
          authorName: it.reviewerUserName || it.authorName || 'Reviewer',
          createdAt: it.reviewDate || it.createdAt || '',
          publicUrl: pickPublicUrl(it),
          text,
          fix: true    // tell webhook to replace the card, not add another
        })
      });
      if (!resp.ok) { errors++; continue; }
      fixed++;
    } catch { errors++; }
  }

  return res.json({ ok:true, since:sinceIso, checked, fixed, skipped, errors });
}

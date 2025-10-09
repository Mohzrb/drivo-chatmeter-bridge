// Minimal Yelp Fusion helper with light retry/backoff.
// Usage: const data = await getYelpReviewsByAlias('drivo-rent-a-car-newark', process.env.YELP_API_KEY)

export async function getYelpReviewsByAlias(alias, apiKey) {
  if (!alias || !apiKey) return null;
  const url = `https://api.yelp.com/v3/businesses/${encodeURIComponent(alias)}/reviews`;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (r.status === 429) { await wait(600 + attempt * 800); continue; }
      const txt = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${txt}`);
      return JSON.parse(txt); // { reviews:[{ id,text,rating,time_created,user:{name},url }], ... }
    } catch (e) {
      lastErr = e;
      await wait(300 + attempt * 500);
    }
  }
  throw lastErr || new Error("Yelp fetch failed");
}

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

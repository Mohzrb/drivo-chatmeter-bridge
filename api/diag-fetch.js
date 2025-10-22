export default async function handler(req, res) {
  try {
    // Intentionally no env, no helpers, no JSON parsing
    const url = "https://live.chatmeter.com/v5/reviews?limit=1";
    let status = null, text = null;

    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      status = r.status;
      text = await r.text();
    } catch (err) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, step: "fetch", error: String(err?.message || err) }));
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      url,
      status,
      // Show only first 1000 chars to avoid huge payloads
      preview: (text || "").slice(0, 1000)
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

// api/review-webhook.js
// Secured webhook → forwards body to /api/review-intake

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  const secret = process.env.WEBHOOK_SECRET;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!secret || token !== secret) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const origin = `https://${req.headers.host}`;
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});

    const r = await fetch(`${origin}/api/review-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw
    });

    const data = await r.json().catch(() => null);
    return res.status(r.status).json(data ?? { ok: false, error: "Downstream error" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

export default async function handler(req, res) {
  const want = process.env.CRON_SECRET;
  const got  = req.headers.authorization || "";
  if (want && got !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return res.status(200).json({ ok: true, route: "/api/fix-missing-links", envLoaded: !!process.env.ZENDESK_SUBDOMAIN });
}

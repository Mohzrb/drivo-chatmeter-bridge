export default async function handler(req, res) {
  return res.status(200).json({ ok: true, version: "ping-2025-10-07" });
}

export default function handler(req, res) {
  res.status(200).json({ ok: true, version: "ping-2025-10-07" });
}

// Chatmeter → Zendesk (create ticket)
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
  res.status(200).json({ ok: true, msg: "review-webhook alive" });
}

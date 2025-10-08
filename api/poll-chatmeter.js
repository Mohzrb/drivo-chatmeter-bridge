// Poll Chatmeter for recent/updated reviews and create Zendesk tickets
export default async function handler(req, res) {
  const CHM_BASE  = process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
  const CHM_TOKEN = process.env.CHATMETER_V5_TOKEN;
  const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
  const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
  const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN;

  if (!CHM_TOKEN) return res.status(500).send("Missing CHATMETER_V5_TOKEN");

  // Pull “recently updated” – adjust window as you like
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // last 15 minutes
  const url = `${CHM_BASE}/reviews?updatedSince=${encodeURIComponent(since)}&sortField=reviewDate&sortOrder=DESC`;

  try {
    const list = await fetch(url, { headers: { "Authorization": CHM_TOKEN }});
    if (!list.ok) return res.status(502).send(`Chatmeter list error: ${list.status} ${await list.text()}`);
    const data = await list.json();

    // For each review, call our existing ticket creator internally
    let created = 0;
    for (const r of (data?.results || data || [])) {
      const payload = {
        id: r.id, locationId: r.locationId, locationName: r.locationName,
        rating: r.rating, authorName: r.authorName, createdAt: r.reviewDate,
        text: r.text, publicUrl: r.publicUrl, portalUrl: r.portalUrl
      };
      await fetch(process.env.SELF_BASE_URL + "/api/review-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      created++;
    }

    return res.status(200).json({ ok: true, checked: (data?.results || data || []).length, created });
  } catch (e) {
    return res.status(500).send(`Error: ${e?.message || e}`);
  }
}

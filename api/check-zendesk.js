// pages/api/check-zendesk.js
export default async function handler(req, res) {
  try {
    const {
      ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL,
      ZENDESK_API_TOKEN,
      ZENDESK_BRAND_ID,
      ZENDESK_GROUP_ID,
      ZENDESK_REQUESTER_EMAIL,
    } = process.env;

    if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) {
      return res.status(400).json({
        ok: false,
        error: "Missing required env: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN",
      });
    }

    const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");

    // 1) Verify credentials (current user)
    const meResp = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    // 2) Optional sanity (brand + group) — ignore failures but report
    let brandOk = null, groupOk = null;
    if (ZENDESK_BRAND_ID) {
      const b = await fetch(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/brands/${ZENDESK_BRAND_ID}.json`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      brandOk = b.ok;
    }
    if (ZENDESK_GROUP_ID) {
      const g = await fetch(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/groups/${ZENDESK_GROUP_ID}.json`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      groupOk = g.ok;
    }

    if (!meResp.ok) {
      const text = await meResp.text();
      return res.status(meResp.status).json({ ok: false, where: "users/me", detail: text });
    }

    const me = await meResp.json();

    return res.status(200).json({
      ok: true,
      zendesk: {
        me: { id: me?.user?.id, name: me?.user?.name, email: me?.user?.email },
        brand_check: ZENDESK_BRAND_ID ? { id: ZENDESK_BRAND_ID, ok: brandOk } : null,
        group_check: ZENDESK_GROUP_ID ? { id: ZENDESK_GROUP_ID, ok: groupOk } : null,
      },
      configured: {
        ZENDESK_SUBDOMAIN: !!ZENDESK_SUBDOMAIN,
        ZENDESK_EMAIL: !!ZENDESK_EMAIL,
        ZENDESK_API_TOKEN: !!ZENDESK_API_TOKEN,
        ZENDESK_BRAND_ID: !!ZENDESK_BRAND_ID,
        ZENDESK_GROUP_ID: !!ZENDESK_GROUP_ID,
        ZENDESK_REQUESTER_EMAIL: !!ZENDESK_REQUESTER_EMAIL,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

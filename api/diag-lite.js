export default async function handler(req, res) {
  try {
    const presence = {
      CHATMETER_V5_BASE: !!process.env.CHATMETER_V5_BASE,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      CHATMETER_TOKEN: !!process.env.CHATMETER_TOKEN,
      CHATMETER_API_KEY: !!process.env.CHATMETER_API_KEY,
      CHATMETER_USERNAME: !!process.env.CHATMETER_USERNAME,
      CHATMETER_PASSWORD: !!process.env.CHATMETER_PASSWORD,
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN,
      CRON_SECRET: !!process.env.CRON_SECRET
    };

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, presence }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

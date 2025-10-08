export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    version: "selftest-2025-10-07",
    have: {
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      SELF_BASE_URL: !!process.env.SELF_BASE_URL
    }
  });
}

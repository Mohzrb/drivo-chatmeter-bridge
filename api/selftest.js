// api/selftest.js
export default function handler(req, res) {
  res.status(200).json({
    node: process.version,
    env: {
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN,
      ZD_FIELD_REVIEW_ID: !!process.env.ZD_FIELD_REVIEW_ID,
      ZD_FIELD_LOCATION_ID: !!process.env.ZD_FIELD_LOCATION_ID,
      ZD_FIELD_RATING: !!process.env.ZD_FIELD_RATING,
      ZD_FIELD_FIRST_REPLY_SENT: !!process.env.ZD_FIELD_FIRST_REPLY_SENT
    }
  });
}

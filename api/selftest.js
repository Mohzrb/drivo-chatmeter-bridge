// /api/selftest.js
import { HELPERS_VERSION } from "./_helpers.js";

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    version: "selftest-2025-10-10",
    helpers: HELPERS_VERSION,
    have: {
      ZENDESK_SUBDOMAIN: !!process.env.ZENDESK_SUBDOMAIN,
      ZENDESK_EMAIL: !!process.env.ZENDESK_EMAIL,
      ZENDESK_API_TOKEN: !!process.env.ZENDESK_API_TOKEN,
      ZD_FIELD_REVIEW_ID: !!process.env.ZD_FIELD_REVIEW_ID,
      ZD_FIELD_LOCATION_ID: !!process.env.ZD_FIELD_LOCATION_ID,
      ZD_FIELD_RATING: !!process.env.ZD_FIELD_RATING,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      CHM_ACCOUNT_ID: !!process.env.CHM_ACCOUNT_ID,
    },
  });
}

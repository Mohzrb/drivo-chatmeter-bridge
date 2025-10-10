// /api/selftest.js
import { HELPERS_VERSION } from "./_helpers.js";

export default function handler(req, res) {
  // stop any caching at CDN or browser
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");

  res.status(200).json({
    ok: true,
    version: "selftest-2025-10-10",          // <- should change after deploy
    helpers: HELPERS_VERSION,                // <- from _helpers.js
    env: {
      vercelEnv: process.env.VERCEL_ENV || null,              // "production" | "preview" | "development"
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,   // commit id serving this response
      project: process.env.VERCEL_PROJECT_NAME || null,
      region: process.env.VERCEL_REGION || null,
      time: new Date().toISOString(),
    },
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

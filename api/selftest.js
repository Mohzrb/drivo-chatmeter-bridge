import { json } from "./_helpers.js";

function present(name) {
  return !!process.env[name];
}

export default function handler(req, res) {
  const env = {
    vercelEnv: process.env.VERCEL_ENV || "unknown",
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
    project: process.env.VERCEL_PROJECT_PRODUCTION_URL || "unknown"
  };

  const vars = {
    ZENDESK_SUBDOMAIN: present("ZENDESK_SUBDOMAIN"),
    ZENDESK_EMAIL: present("ZENDESK_EMAIL"),
    ZENDESK_API_TOKEN: present("ZENDESK_API_TOKEN"),
    ZD_AGENT_ID: present("ZD_AGENT_ID"),
    ZD_FIELD_REVIEW_ID: present("ZD_FIELD_REVIEW_ID"),
    ZD_FIELD_LOCATION_ID: present("ZD_FIELD_LOCATION_ID"),
    ZD_FIELD_RATING: present("ZD_FIELD_RATING"),
    CHATMETER_V5_BASE: present("CHATMETER_V5_BASE"),
    CHATMETER_V5_TOKEN: present("CHATMETER_V5_TOKEN"),
    CHATMETER_TOKEN: present("CHATMETER_TOKEN"),
    CHATMETER_API_KEY: present("CHATMETER_API_KEY"),
    SELF_BASE_URL: present("SELF_BASE_URL"),
    CRON_SECRET: present("CRON_SECRET"),
    POLLER_LOOKBACK_MINUTES: present("POLLER_LOOKBACK_MINUTES")
  };

  return json(res, 200, {
    ok: true,
    route: "/api/selftest",
    env,
    vars
  });
}

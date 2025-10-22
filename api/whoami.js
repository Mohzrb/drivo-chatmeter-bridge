import { json } from "./_helpers.js";
import { whoami as zdWho } from "../lib/zendesk.js";

export default async function handler(req, res) {
  try {
    const env = {
      vercelEnv: process.env.VERCEL_ENV || "unknown",
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
      project: process.env.VERCEL_PROJECT_PRODUCTION_URL || "unknown"
    };

    const me = await zdWho(); // Calls Zendesk API to identify your account
    json(res, 200, {
      ok: true,
      route: "/api/whoami",
      version: "whoami-2025-10-10",
      env,
      zendesk: me
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

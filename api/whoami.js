// api/whoami.js — self-contained, no imports
export default async function handler(req, res) {
  try {
    const now = new Date().toISOString();
    const safe = (v) => (v == null ? null : String(v));

    const env = {
      vercelEnv: safe(process.env.VERCEL_ENV),           // "production" | "preview" | "development"
      commitSha: safe(process.env.VERCEL_GIT_COMMIT_SHA),
      project:   safe(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL),
    };

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        route: "/api/whoami",
        version: "whoami-2025-10-23",
        time: now,
        env,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

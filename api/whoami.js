// /api/whoami.js
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.status(200).json({
    ok: true,
    route: "/api/whoami",
    version: "whoami-2025-10-10",
    env: {
      vercelEnv: process.env.VERCEL_ENV || null,            // production | preview | development
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null, // commit id
      project: process.env.VERCEL_PROJECT_NAME || null,
      region: process.env.VERCEL_REGION || null,
      time: new Date().toISOString(),
    },
  });
}

import { json } from "./_helpers.js";

export default async function handler(req, res) {
  try {
    // 1) Show presence (not values) of envs the poller needs
    const presence = {
      CHATMETER_V5_BASE: !!process.env.CHATMETER_V5_BASE,
      CHATMETER_V5_TOKEN: !!process.env.CHATMETER_V5_TOKEN,
      CHATMETER_TOKEN: !!process.env.CHATMETER_TOKEN,
      CHATMETER_API_KEY: !!process.env.CHATMETER_API_KEY,
      CRON_SECRET: !!process.env.CRON_SECRET
    };

    // 2) Try a tiny call to Chatmeter with FULL error capture
    const base =
      process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
    const token =
      process.env.CHATMETER_V5_TOKEN ||
      process.env.CHATMETER_TOKEN ||
      process.env.CHATMETER_API_KEY ||
      "";

    if (!token) {
      return json(res, 200, {
        ok: false,
        step: "env",
        presence,
        error: "No Chatmeter token detected in any supported var"
      });
    }

    const url = `${base}/reviews?limit=1&since=${encodeURIComponent(
      new Date(Date.now() - 60 * 60 * 1000).toISOString()
    )}`;

    let status = null,
      text = null,
      jsonBody = null;

    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        cache: "no-store"
      });
      status = r.status;
      // Return body safely (as text), and try to parse JSON if possible
      text = await r.text().catch(() => "");
      try {
        jsonBody = JSON.parse(text);
      } catch {
        jsonBody = null;
      }
    } catch (err) {
      return json(res, 200, {
        ok: false,
        step: "fetch",
        presence,
        error: String(err?.message || err)
      });
    }

    return json(res, 200, {
      ok: true,
      step: "call",
      presence,
      status,
      text: text?.slice(0, 4000), // cap to avoid huge responses
      json: jsonBody
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

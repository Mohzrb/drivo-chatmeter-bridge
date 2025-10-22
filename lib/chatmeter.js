import { normalizeReview } from "./schema.js";

/** Read Chatmeter token from any of the accepted env var names */
export function getChatmeterToken() {
  return (
    process.env.CHATMETER_V5_TOKEN ||
    process.env.CHATMETER_TOKEN ||
    process.env.CHATMETER_API_KEY ||
    ""
  );
}

/** Base URL for Chatmeter v5 API */
export function getChatmeterBase() {
  return process.env.CHATMETER_V5_BASE || "https://live.chatmeter.com/v5";
}

/**
 * Fetch Chatmeter reviews updated since a given ISO timestamp.
 * Returns an array of normalized review objects.
 *
 * @param {string} sinceIso - ISO datetime string
 * @param {number} limit    - max number of reviews to fetch
 */
export async function fetchReviewsSince(sinceIso, limit = 50) {
  const token = getChatmeterToken();
  if (!token) {
    throw new Error(
      "Missing Chatmeter token: set CHATMETER_V5_TOKEN or CHATMETER_TOKEN or CHATMETER_API_KEY"
    );
  }

  const base = getChatmeterBase();
  const url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Chatmeter HTTP ${r.status}: ${text}`);
  }

  const json = await r.json();
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return arr.map(normalizeReview);
}

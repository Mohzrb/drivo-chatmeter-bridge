import fs from "node:fs";
import path from "node:path";

let _map = null;

function loadProviderMap() {
  if (_map) return _map;

  if (process.env.PROVIDER_IDS_JSON) {
    try {
      _map = JSON.parse(process.env.PROVIDER_IDS_JSON);
      return _map;
    } catch {}
  }

  try {
    const p = path.join(process.cwd(), "src", "config", "providerIds.json");
    _map = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    _map = {};
  }

  return _map;
}

export function getLocEntry(locationId) {
  const m = loadProviderMap();
  return m?.[String(locationId)] || null;
}

export function getGlobalEntry() {
  const m = loadProviderMap();
  return m?.DRIVO_GLOBAL || null;
}

export function yelpUrlFromAlias(alias) {
  return alias ? `https://www.yelp.com/biz/${encodeURIComponent(alias)}` : null;
}

export function googleReviewsUrlFromConfig(entry) {
  return entry?.google_url || null;
}

export function trustpilotUrlFromConfig(entry, globalEntry) {
  return entry?.trustpilot_url || globalEntry?.trustpilot_url || null;
}

// Flexible Chatmeter client: supports token OR username/password login,
// custom reviews URL, scope/id, and multiple auth header styles.

function env(name, def = "") {
  const v = process.env[name];
  return v == null ? def : v;
}
function envAny(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return "";
}

function getBase() {
  return env("CHATMETER_V5_BASE", "https://live.chatmeter.com/v5");
}

/**
 * If CHATMETER_USERNAME/PASSWORD are set, logs in and returns { token, cookie, base }.
 * Otherwise uses any of CHATMETER_V5_TOKEN / CHATMETER_TOKEN / CHATMETER_API_KEY.
 */
export async function getAuth() {
  const base = getBase();

  const user = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
  const pass = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");

  if (user && pass) {
    const r = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
      cache: "no-store"
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const token = json?.token || json?.access_token || "";
    // capture simple cookie pair if any (name=value)
    const setCookie = r.headers.get("set-cookie") || "";
    const cookie = setCookie ? setCookie.split(";")[0] : "";

    if (!token && !cookie) {
      throw new Error(`Chatmeter login failed (${r.status}): ${text.slice(0, 300)}`);
    }
    return { base, token, cookie };
  }

  const token = envAny("CHATMETER_V5_TOKEN", "CHATMETER_TOKEN", "CHATMETER_API_KEY");
  if (!token) throw new Error("Missing CHATMETER token or username/password");
  return { base, token, cookie: "" };
}

/**
 * Build headers for authenticated calls based on CHATMETER_AUTH_STYLE.
 * Supported:
 *  - bearer  -> Authorization: Bearer <token>   (default)
 *  - token   -> Authorization: Token <token>
 *  - token_eq-> Authorization: Token token=<token>
 *  - xauth   -> X-Auth-Token: <token>
 *  - xapikey -> X-API-Key: <token>
 *  - cookie  -> Cookie: <cookie OR token>
 *  - cookie_bearer -> Cookie + Authorization: Bearer <token>
 */
export function buildAuthHeaders({ token, cookie }) {
  const style = env("CHATMETER_AUTH_STYLE", "bearer").toLowerCase();
  const headers = { Accept: "application/json" };

  switch (style) {
    case "token":
      headers.Authorization = `Token ${token}`;
      break;
    case "token_eq":
      headers.Authorization = `Token token=${token}`;
      break;
    case "xauth":
      headers["X-Auth-Token"] = token;
      break;
    case "xapikey":
      headers["X-API-Key"] = token;
      break;
    case "cookie":
      headers.Cookie = cookie || `token=${token}`;
      break;
    case "cookie_bearer":
      if (cookie) headers.Cookie = cookie;
      headers.Authorization = `Bearer ${token}`;
      break;
    case "bearer":
    default:
      headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Compute the reviews URL using the most specific config available:
 * 1) CHATMETER_REVIEWS_URL (absolute) — recommended
 * 2) CHATMETER_SCOPE + CHATMETER_SCOPE_ID -> {base}/{scope}/{id}/reviews
 * 3) Root {base}/reviews with optional ?{idParam}=... (CHATMETER_ID_PARAM)
 */
export function buildReviewsUrl(base, sinceIso, limit) {
  const override = env("CHATMETER_REVIEWS_URL", "").trim();
  if (override) {
    // Append standard query params if the URL has no since/limit yet
    const u = new URL(override);
    if (!u.searchParams.has("since")) u.searchParams.set("since", sinceIso);
    if (!u.searchParams.has("limit")) u.searchParams.set("limit", String(limit));
    return u.toString();
  }

  const scope = env("CHATMETER_SCOPE", "").trim(); // e.g., "accounts", "locations", "companies"
  const scopeId = env("CHATMETER_SCOPE_ID", "").trim();
  const idParam = env("CHATMETER_ID_PARAM", "").trim(); // e.g., "accountId"

  if (scope && scopeId) {
    return `${base}/${scope}/${encodeURIComponent(scopeId)}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;
  }

  let url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;
  const configuredId = env("CHATMETER_ID_VALUE", "").trim();
  if (idParam && configuredId) {
    url += `&${encodeURIComponent(idParam)}=${encodeURIComponent(configuredId)}`;
  }
  return url;
}

/**
 * Fetch reviews using flexible config. Returns raw JSON (array or {data:[]})
 */
export async function fetchReviewsFlexible(sinceIso, limit = 50) {
  const auth = await getAuth();
  const headers = buildAuthHeaders(auth);
  const url = buildReviewsUrl(auth.base, sinceIso, limit);

  const r = await fetch(url, { headers, cache: "no-store" });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(`Chatmeter reviews ${r.status}: ${text.slice(0, 400)}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Chatmeter reviews returned non-JSON body (len=${text.length})`);
  }
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return arr;
}

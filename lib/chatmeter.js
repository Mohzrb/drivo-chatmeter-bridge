// Flexible Chatmeter client with:
// - API key vs login preference
// - Multiple auth header styles (raw/xauth/token/token_eq/bearer/cookie)
// - Auto-retry across styles on 401/403
// - Config-driven reviews URL

function env(name, def = "") {
  const v = process.env[name];
  return v == null ? def : v;
}
function envAny(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return "";
}

function getBase() {
  return env("CHATMETER_V5_BASE", "https://live.chatmeter.com/v5");
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
/**
 * Preference rules:
 * - If CHATMETER_V5_TOKEN exists and CHATMETER_AUTH_STYLE is one of
 *   ["raw","xauth","xapikey","token","token_eq"], we use that API key (NO login).
 * - Otherwise, if username/password exist, we login and use that token.
 * - Otherwise, fall back to CHATMETER_V5_TOKEN (bearer).
 */
export async function getAuth() {
  const base = getBase();

  const style = (process.env.CHATMETER_AUTH_STYLE || "bearer").toLowerCase();
  const apiKey = envAny("CHATMETER_V5_TOKEN", "CHATMETER_TOKEN", "CHATMETER_API_KEY");
  const user  = envAny("CHATMETER_USERNAME", "Chatmeter_username", "chatmeter_username");
  const pass  = envAny("CHATMETER_PASSWORD", "Chatmeter_password", "chatmeter_password");

  const keyStyles = new Set(["raw", "xauth", "xapikey", "token", "token_eq"]);

  // Prefer API key (no login) when style indicates key-style auth
  if (apiKey && keyStyles.has(style)) {
    return { base, token: apiKey, cookie: "" };
  }

  // Otherwise, try login if creds exist
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
    const setCookie = r.headers.get("set-cookie") || "";
    const cookie = setCookie ? setCookie.split(";")[0] : "";
    if (!token && !cookie) {
      throw new Error(`Chatmeter login failed (${r.status}): ${text.slice(0, 300)}`);
    }
    return { base, token, cookie };
  }

  // Fallback to API key (bearer)
  if (apiKey) return { base, token: apiKey, cookie: "" };

  throw new Error("Missing Chatmeter credentials (no API key and no username/password).");
}

export function buildAuthHeaders(style, { token, cookie }) {
  const s = (style || "bearer").toLowerCase();
  const h = { Accept: "application/json" };

  switch (s) {
    case "raw":
      // Authorization: <token>
      h.Authorization = token;
      break;
    case "xauth":
      // X-Auth-Token: <token>
      h["X-Auth-Token"] = token;
      break;
    case "xapikey":
      // X-API-Key: <token>
      h["X-API-Key"] = token;
      break;
    case "token":
      // Authorization: Token <token>
      h.Authorization = `Token ${token}`;
      break;
    case "token_eq":
      // Authorization: Token token=<token>
      h.Authorization = `Token token=${token}`;
      break;
    case "cookie":
      h.Cookie = cookie || `token=${token}`;
      break;
    case "cookie_bearer":
      if (cookie) h.Cookie = cookie;
      h.Authorization = `Bearer ${token}`;
      break;
    case "bearer":
    default:
      h.Authorization = `Bearer ${token}`;
  }
  return h;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------
export function buildReviewsUrl(base, sinceIso, limit) {
  const override = env("CHATMETER_REVIEWS_URL", "").trim();
  if (override) {
    const u = new URL(override);
    if (!u.searchParams.has("since")) u.searchParams.set("since", sinceIso);
    if (!u.searchParams.has("limit")) u.searchParams.set("limit", String(limit));
    return u.toString();
  }

  const scope   = env("CHATMETER_SCOPE", "").trim();
  const scopeId = env("CHATMETER_SCOPE_ID", "").trim();
  const idParam = env("CHATMETER_ID_PARAM", "").trim();
  const idValue = env("CHATMETER_ID_VALUE", "").trim();

  if (scope && scopeId) {
    return `${base}/${scope}/${encodeURIComponent(scopeId)}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;
  }

  let url = `${base}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;
  if (idParam && idValue) url += `&${encodeURIComponent(idParam)}=${encodeURIComponent(idValue)}`;
  return url;
}

// ---------------------------------------------------------------------------
// Fetch with auto-retry of auth styles
// ---------------------------------------------------------------------------
export async function fetchReviewsFlexible(sinceIso, limit = 50) {
  const auth = await getAuth();
  const baseStyle = (process.env.CHATMETER_AUTH_STYLE || "bearer").toLowerCase();
  const url = buildReviewsUrl(auth.base, sinceIso, limit);

  // Order we’ll try. Start with requested style, then fallbacks.
  const stylesTried = new Set();
  const sequence = [baseStyle, "raw", "xauth", "token", "token_eq", "bearer"];
  for (const s of sequence) {
    if (stylesTried.has(s)) continue;
    stylesTried.add(s);

    const headers = buildAuthHeaders(s, auth);
    const r = await fetch(url, { headers, cache: "no-store" });
    const text = await r.text().catch(() => "");
    if (r.ok) {
      let json;
      try { json = JSON.parse(text); } catch {
        throw new Error(`Chatmeter reviews returned non-JSON body (len=${text.length})`);
      }
      return Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
    }

    // Only try the next style on 401/403; otherwise fail immediately.
    if (r.status !== 401 && r.status !== 403) {
      throw new Error(`Chatmeter reviews ${r.status}: ${text.slice(0, 400)}`);
    }
  }

  // If we got here, all styles 401/403'd
  throw new Error(`Chatmeter reviews unauthorized with styles: ${Array.from(stylesTried).join(", ")}`);
}

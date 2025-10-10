// /api/_helpers.js — FINAL with deep/recursive extraction & version
export const HELPERS_VERSION = "helpers-2025-10-10-rb-deep";

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
export function normalizeProvider(p) {
  if (!p) return "";
  const t = p.toString().toUpperCase();
  if (t.includes("GOOGLE")) return "GOOGLE";
  if (t.includes("YELP")) return "YELP";
  if (t.includes("REVIEWBUILDER")) return "REVIEWBUILDER";
  if (t.includes("FACEBOOK")) return "FACEBOOK";
  return t;
}
export function pickCustomerContact(o = {}) {
  const email = o.reviewerEmail || o.authorEmail || o.email || o.customerEmail || "";
  const phone = o.reviewerPhone || o.authorPhone || o.phone || o.customerPhone || "";
  return { email: isNonEmptyString(email) ? email.trim() : "", phone: isNonEmptyString(phone) ? phone.trim() : "" };
}

/* ---------- deep text scan ----------- */
function deepScanForText(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = deepScanForText(it);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (isNonEmptyString(v)) {
      const s = v.trim();
      if (!/^(true|false|null|undefined)$/i.test(s) && !/^https?:\/\//i.test(s)) {
        // prefer keys likely to be free-text
        if (/own\s*words|experience|feedback|comment|describe|verbatim|free\s*text/i.test(k)) return s;
      }
    } else if (v && typeof v === "object") {
      const found = deepScanForText(v);
      if (found) return found;
    }
  }
  return null;
}

/* ---------- provider-agnostic comment ---------- */
export function getProviderComment(provider, data = {}) {
  if (!data || typeof data !== "object") return "";

  // direct/common fields first
  const directPaths = [
    "text","comment","body","reviewText","reviewBody",
    "review.text","review.comment",
    "reviewData.commentText","reviewData.freeText","reviewData.reviewBody"
  ];
  for (const path of directPaths) {
    const parts = path.split(".");
    let val = data;
    for (const p of parts) val = val && typeof val === "object" ? val[p] : undefined;
    if (isNonEmptyString(val)) {
      const s = String(val).trim();
      if (!/^(true|false|null|undefined)$/i.test(s)) return s;
    }
  }

  // ReviewBuilder: array of Q&A objects
  if (Array.isArray(data.reviewData)) {
    const best = [];
    for (const rd of data.reviewData) {
      const name = String(rd?.name || "").toLowerCase();
      const val  = String(rd?.value ?? rd?.answer ?? "").trim();
      if (!isNonEmptyString(val)) continue;
      if (/own\s*words|experience|feedback|comment|describe|verbatim|free\s*text/.test(name)) best.push(val);
    }
    if (best.length) return best.join("\n\n");
  }

  if (Array.isArray(data.answers)) {
    const best = [];
    for (const a of data.answers) {
      const q = String(a?.question || "").toLowerCase();
      const val = String(a?.answer || "").trim();
      if (!isNonEmptyString(val)) continue;
      if (/own\s*words|experience|feedback|comment|describe|verbatim|free\s*text/.test(q)) best.push(val);
    }
    if (best.length) return best.join("\n\n");
  }

  // final fallback: recursive scan
  const found = deepScanForText(data);
  return isNonEmptyString(found) ? found : "";
}

/* ---------- stars & note ---------- */
function stars(n) {
  const x = Math.max(0, Math.min(5, Number(n) || 0));
  return "★".repeat(x) + "☆".repeat(5 - x);
}
export function buildInternalNote({ dt, customerName, customerEmail, customerPhone, provider, locationName, locationId, rating, comment, viewUrl }) {
  const lines = [
    "Review Information","",
    `Date: ${dt || "-"}`,
    `Customer: ${customerName || "-"}`,
    `Provider: ${provider || "-"}`,
    `Location: ${locationName ? `${locationName} (${locationId || "-"})` : (locationId || "-")}`,
    `Rating: ${stars(rating)}`,
    `Comment:`,
    isNonEmptyString(comment) ? comment : "(no text)","",
    isNonEmptyString(viewUrl) ? `[View in Chatmeter](${viewUrl})` : "","",
    "_The first public comment on this ticket will be posted to Chatmeter._",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Generate a simple hash of a string (djb2 algorithm)
 * Used internally to compare text quickly
 */
export function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return (h >>> 0).toString(16);
}

/**
 * Check if a comment body already exists in recent Zendesk ticket audits
 * (to avoid duplicate internal notes)
 * @param {Array} audits - Zendesk audits array
 * @param {string} commentBody - text we plan to post
 * @returns {boolean} true if a duplicate exists
 */
export function commentExists(audits, commentBody) {
  const target = commentBody.trim();
  for (const audit of audits || []) {
    for (const ev of audit.events || []) {
      if (ev.type === "Comment" && typeof ev.body === "string") {
        const existing = ev.body.trim();
        if (existing === target) return true;
      }
    }
  }
  return false;
}

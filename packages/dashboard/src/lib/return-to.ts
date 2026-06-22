/**
 * Post-login redirect target ("returnTo") handling, shared by the auth gate
 * (App) and the login page (OAuth callbackURL).
 *
 * SECURITY: only a same-origin app path is allowed — never an absolute or
 * protocol-relative URL. Browsers normalize backslashes to slashes and strip
 * control/whitespace chars, so "/\evil.com" or "/<tab>//evil.com" would resolve
 * to an external host; we reject those too. A valid value is "/x…" where the
 * char after the leading slash is not another slash.
 */
const SAFE_PATH = /^\/[^/]/; // "/x", not "//…", bare "/", or protocol-relative

export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.includes("\\")) return null; // backslash → browsers treat as "/"
  // Reject any control char or whitespace (browsers strip tab/newline, which
  // can turn "/<tab>//evil" into a protocol-relative URL).
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) <= 0x20) return null;
  }
  if (!SAFE_PATH.test(raw)) return null;
  return raw;
}

/** The validated ?returnTo from the current URL, or null. */
export function currentReturnTo(): string | null {
  return safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
}

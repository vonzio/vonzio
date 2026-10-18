/**
 * Redaction helpers for auth-path logging.
 *
 * Better Auth responses and the cookies around them carry live session
 * tokens. Anyone with `docker logs` access, or a log shipper, would
 * otherwise get a usable session out of an info-level line. These helpers
 * keep the diagnostic shape (which cookies were present, what the body
 * looked like) while dropping every secret value.
 */

const SECRET_KEYS = new Set([
  "token",
  "session_token",
  "sessiontoken",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "password",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "set-cookie",
]);

export const REDACTED = "[redacted]";

/** Cookie names from a `Cookie:` request header, values dropped. */
export function cookieNames(header: string | undefined | null): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter((name) => name.length > 0);
}

/** Cookie names from `Set-Cookie` headers, values and attributes dropped. */
export function setCookieNames(headers: readonly string[]): string[] {
  return headers
    .map((h) => h.split(";")[0]?.split("=")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

/**
 * Deep-redact any key that looks like a credential. Non-JSON input is
 * replaced wholesale: an opaque body is more likely to be a token than
 * a useful error message, and Better Auth errors are JSON anyway.
 */
export function redactAuthBody(text: string): unknown {
  if (!text) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return REDACTED;
  }
  return redactValue(parsed);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * pino `redact` paths for the Fastify logger. The default request
 * serializer does not log headers, but anything that logs `req`/`res`
 * or a `headers` object directly is covered here as a backstop.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.cookie",
  "headers.authorization",
  "requestCookies",
  "setCookies",
];

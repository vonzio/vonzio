/**
 * Root-relative URL rewriting for the path-mode preview proxy.
 *
 * Path mode serves a container app under `/preview/<slug>/<port>/` on the
 * dashboard origin. The app thinks it lives at `/`, so a page that links
 * `/static/style.css` sends the browser to the dashboard's `/static/...`
 * instead of the app's. These helpers put the prefix back on root-relative
 * URLs in HTML attributes, inline styles, CSS `url()` / `@import`, and
 * redirect `Location` headers. Protocol-relative (`//cdn`), absolute,
 * relative and already-prefixed URLs are left alone.
 *
 * Hostname mode gives each app its own origin and needs none of this.
 */

/** Prefix a root-relative URL; anything else comes back unchanged. */
export function prefixRootRelative(url: string, prefix: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`) || url.startsWith(`${prefix}#`)) return url;
  return prefix + url;
}

const CSS_URL_RE = /url\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(["'])(\/(?!\/)[^"']*)\1/gi;

export function rewriteCss(css: string, prefix: string): string {
  return css
    .replace(CSS_URL_RE, (_m, q: string, url: string) => `url(${q}${prefixRootRelative(url, prefix)}${q})`)
    .replace(CSS_IMPORT_RE, (_m, q: string, url: string) => `@import ${q}${prefixRootRelative(url, prefix)}${q}`);
}

// Single-URL attributes. Matches a quoted or unquoted value after whitespace,
// so `data-src=` / `xsrc=` are not caught.
const URL_ATTR_RE = /(\s(?:src|href|action|formaction|poster)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SRCSET_ATTR_RE = /(\s(?:srcset|imagesrcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR_RE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;

function quoteBack(lead: string, dq: string | undefined, sq: string | undefined, value: string): string {
  if (dq !== undefined) return `${lead}"${value}"`;
  if (sq !== undefined) return `${lead}'${value}'`;
  return `${lead}${value}`;
}

function rewriteSrcset(value: string, prefix: string): string {
  return value
    .split(",")
    .map((candidate) => candidate.replace(/^(\s*)(\S+)/, (_m, ws: string, url: string) => ws + prefixRootRelative(url, prefix)))
    .join(",");
}

export function rewriteHtml(html: string, prefix: string): string {
  return html
    .replace(URL_ATTR_RE, (_m, lead: string, dq?: string, sq?: string, bare?: string) =>
      quoteBack(lead, dq, sq, prefixRootRelative((dq ?? sq ?? bare)!, prefix)))
    .replace(SRCSET_ATTR_RE, (_m, lead: string, dq?: string, sq?: string) =>
      quoteBack(lead, dq, sq, rewriteSrcset((dq ?? sq)!, prefix)))
    .replace(STYLE_ATTR_RE, (_m, lead: string, dq?: string, sq?: string) =>
      quoteBack(lead, dq, sq, rewriteCss((dq ?? sq)!, prefix)))
    .replace(STYLE_BLOCK_RE, (_m, open: string, body: string, close: string) => open + rewriteCss(body, prefix) + close);
}

/**
 * Rewrite a redirect `Location`. Root-relative targets get the prefix; an
 * absolute URL pointing back at the upstream container (`http://<ip>:<port>/x`)
 * becomes the prefixed path. Anything else is untouched.
 */
export function rewriteLocation(location: string, prefix: string, upstreamHost: string): string {
  if (location.startsWith("/")) return prefixRootRelative(location, prefix);
  try {
    const u = new URL(location);
    if (u.host === upstreamHost) return prefixRootRelative(u.pathname + u.search + u.hash, prefix);
  } catch { /* relative or malformed — leave it */ }
  return location;
}

/** Which body rewriter (if any) applies to a response content type. */
export function rewriterFor(contentType: string | undefined): ((body: string, prefix: string) => string) | null {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct === "text/html" || ct === "application/xhtml+xml") return rewriteHtml;
  if (ct === "text/css") return rewriteCss;
  return null;
}

const PREVIEW_REFERER_RE = /^\/preview\/([A-Za-z0-9_.-]+)\/(\d{1,5})(?:\/|$)/;

/**
 * Fallback for root-relative requests the rewriter can't see (URLs built in
 * JS, fetch calls): a GET/HEAD that missed every dashboard route but whose
 * same-origin Referer is a preview page belongs to that preview. Returns the
 * prefixed URL to redirect to, or null.
 */
export function previewRefererRedirect(
  method: string,
  url: string,
  referer: string | undefined,
  host: string | undefined,
): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!referer || !host || !url.startsWith("/") || url.startsWith("//") || url.startsWith("/preview/")) return null;
  let ref: URL;
  try { ref = new URL(referer); } catch { return null; }
  if (ref.host !== host) return null;
  const m = PREVIEW_REFERER_RE.exec(ref.pathname);
  if (!m) return null;
  return `/preview/${m[1]}/${m[2]}${url}`;
}

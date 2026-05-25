/**
 * Rewrite agent-generated markdown/HTML output so that inline image
 * references actually render across surfaces (dashboard, Telegram, Slack).
 *
 * The agent saves images into its workspace and references them with
 * preview URLs the system prompt hands it (e.g.
 * `http://<container>-8000.vonz.localhost/butterfly.png`). The agent has
 * no session context and can't mint auth tokens, so the URLs come back
 * unauthenticated and the browser / Telegram / Slack can't fetch them.
 *
 * The fix is server-side: scan the agent's output, identify preview URLs
 * bound to *this* user's container, and inject a self-validating `_pvt`
 * HMAC token via the existing preview auth checker. The token works
 * without cookies — the preview proxy validates it standalone.
 *
 * Returns three views of the rewritten output:
 *   - `textWithUrls`     image markdown/HTML kept, URLs token-signed (dashboard)
 *   - `textWithoutImages` image refs stripped (Telegram/Slack relay text)
 *   - `images`           the signed URLs + alt text, for surfaces that need
 *                        out-of-band sends (Telegram sendPhoto, Slack image_url)
 */

export interface RewriteContext {
  /** Full container ID for HMAC binding (from sessionRegistry.get(session).container_id). */
  fullContainerId: string;
  /** Owner user_id — signed into the token. */
  userId: string;
  /** Preview URL template, e.g. "http://{container_id}-{port}.vonz.localhost". */
  previewUrlTemplate: string;
  /** Friendly short container name that fills the {container_id} placeholder. */
  containerName: string;
  /** Mints a self-validating `_pvt` token bound to (containerId, userId). */
  signToken: (fullContainerId: string, userId: string) => string;
}

export interface ExtractedImage {
  /** Signed URL ready to fetch (browsers / Telegram / Slack). */
  url: string;
  alt: string;
  /** The original URL the agent emitted, useful for logging/dedup. */
  originalUrl: string;
}

export interface RewrittenAgentOutput {
  textWithUrls: string;
  textWithoutImages: string;
  images: ExtractedImage[];
}

const MARKDOWN_IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Greedy on attributes but stops at the next `>`; permissive on attribute order
// so it matches `<img alt="..." src="...">` and `<img src="..." alt="...">`.
const HTML_IMG_RE = /<img\b([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*)\/?\s*>/gi;

/**
 * Build a regex that matches *only* the preview host bound to this user's
 * container — so we never accidentally sign tokens for arbitrary URLs
 * (wikipedia.org images, third-party CDNs).
 */
function buildHostMatcher(template: string, containerName: string): RegExp | null {
  const schemeIdx = template.indexOf("://");
  if (schemeIdx === -1) return null;
  const hostTemplate = template.slice(schemeIdx + 3).split("/")[0];
  // Escape regex specials except for the placeholders we'll substitute.
  const escaped = hostTemplate
    .split("{container_id}").join("CONTAINER")
    .split("{port}").join("PORT")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .split("CONTAINER").join(containerName.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .split("PORT").join("\\d{4,5}");
  return new RegExp("^" + escaped + "$", "i");
}

export function rewriteAgentImages(text: string, ctx: RewriteContext): RewrittenAgentOutput {
  if (!text) return { textWithUrls: text, textWithoutImages: text, images: [] };

  const hostMatcher = buildHostMatcher(ctx.previewUrlTemplate, ctx.containerName);
  if (!hostMatcher) {
    return { textWithUrls: text, textWithoutImages: text, images: [] };
  }

  // Mint the token lazily — most messages have no images and we'd rather not
  // sign a token that ends up unused.
  let cachedToken: string | null = null;
  const tokenFor = () => {
    if (!cachedToken) cachedToken = ctx.signToken(ctx.fullContainerId, ctx.userId);
    return cachedToken;
  };

  // Dedup images by their original URL so a doubled `![]()` doesn't double-send.
  const imagesByOriginal = new Map<string, ExtractedImage>();

  const rewriteOne = (rawUrl: string, alt: string): { signed: string | null; matched: boolean } => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { signed: null, matched: false };
    }
    if (!hostMatcher.test(parsed.host)) {
      return { signed: null, matched: false };
    }
    // Idempotent: replace existing _pvt rather than appending.
    parsed.searchParams.set("_pvt", tokenFor());
    const signed = parsed.toString();
    if (!imagesByOriginal.has(rawUrl)) {
      imagesByOriginal.set(rawUrl, { url: signed, alt: alt || "image", originalUrl: rawUrl });
    }
    return { signed, matched: true };
  };

  // Single pass over the original text — produces both textWithUrls
  // (URLs swapped to signed) AND textWithoutImages (matched refs gone).
  // Doing both in one walk avoids the URL.toString()-normalization gotcha
  // that bit pass-2-on-textWithUrls: when URL parsing normalizes (uppercase
  // host → lowercase, dropped default port, sorted query), the signed string
  // from imagesByOriginal won't equal the raw substring the second-pass
  // regex sees. Strip directly when we know we matched.
  let textWithUrls = text.replace(MARKDOWN_IMG_RE, (full, alt: string, url: string) => {
    const { signed, matched } = rewriteOne(url, alt);
    return matched && signed ? `![${alt}](${signed})` : full;
  });
  textWithUrls = textWithUrls.replace(HTML_IMG_RE, (full, before: string, src: string, after: string) => {
    const altMatch = full.match(/alt\s*=\s*["']([^"']*)["']/i);
    const alt = altMatch ? altMatch[1] : "image";
    const { signed, matched } = rewriteOne(src, alt);
    return matched && signed ? `<img${before}src="${signed}"${after}>` : full;
  });

  // textWithoutImages comes from the ORIGINAL text — we match on the raw
  // (pre-normalization) URLs we already collected and strip whatever the
  // regex finds whose URL is in our originalUrl set.
  const originalUrlSet = new Set(imagesByOriginal.keys());
  let textWithoutImages = text
    .replace(MARKDOWN_IMG_RE, (full, _alt: string, url: string) => (originalUrlSet.has(url) ? "" : full))
    .replace(HTML_IMG_RE, (full, _before: string, src: string) => (originalUrlSet.has(src) ? "" : full));
  // Collapse the blank space the removed images left behind.
  textWithoutImages = textWithoutImages.replace(/\n{3,}/g, "\n\n").trim();

  return {
    textWithUrls,
    textWithoutImages,
    images: Array.from(imagesByOriginal.values()),
  };
}

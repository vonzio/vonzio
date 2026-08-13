/**
 * Pure helpers for the Document deck tab (#368) — separate from DocumentTab
 * so chat/file components (and unit tests) can use them without pulling the
 * pdf.js viewer into their bundle.
 */

/** Office types the deck can display, and how each is carried. */
const PDF_RENDERED = new Set(["docx", "doc", "pptx", "ppt", "odt", "odp", "rtf"]);
const HTML_RENDERED = new Set(["xlsx", "xls", "ods"]);

export type DocumentKind = "pdf-converted" | "html-converted" | "pdf-raw";

export function documentKind(path: string): DocumentKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (PDF_RENDERED.has(ext)) return "pdf-converted";
  if (HTML_RENDERED.has(ext)) return "html-converted";
  if (ext === "pdf") return "pdf-raw";
  return null;
}

/** Matches a displayable document as a /workspace path OR as an already
 *  rewritten /preview/<id>/files link (assistant prose is often rewritten
 *  server-side before it reaches the client). */
const DOC_PATH_RE = /(?:\/preview\/[\w.-]+\/files)?(\/workspace\/[^\s"'`)\]>*,;]+\.(?:docx|doc|pptx|ppt|odt|odp|rtf|xlsx|xls|ods))\b/i;

/** Extract the first displayable office-document path mentioned in text,
 *  normalized to its /workspace/... form. Deliberately excludes bare .pdf —
 *  agents READ pdfs all the time; auto-opening on every mention would hijack
 *  the deck. (Raw pdfs still open via explicit clicks in Files/chat.) */
export function extractOfficeDocPath(text: string): string | null {
  const m = text.match(DOC_PATH_RE);
  if (!m) return null;
  // Href sources arrive percent-encoded ("Account%20Closure.docx") — store
  // the decoded workspace path; the tab re-encodes when building URLs.
  if (m[1].includes("%")) {
    try { return decodeURIComponent(m[1]); } catch { /* malformed — use as-is */ }
  }
  return m[1];
}

export const OPEN_DOCUMENT_EVENT = "vonzio:open-document";

/** Ask the workspace page to open a document in the deck — usable from any
 *  depth (chat markdown links, file rows) without prop-drilling. */
export function openDocumentInDeck(path: string) {
  window.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_EVENT, { detail: { path } }));
}

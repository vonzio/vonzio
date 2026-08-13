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

const OFFICE_EXTS = "docx|doc|pptx|ppt|odt|odp|rtf|xlsx|xls|ods";

/** A document as a /workspace path, or as a rewritten /preview/<id>/files
 *  link (assistant prose is often rewritten server-side). */
const DOC_PATH_RE = new RegExp(
  `(?:\\/preview\\/[\\w.-]+\\/files)?(\\/workspace\\/[^\\s"'\`)\\]>*,;]+\\.(?:${OFFICE_EXTS}))\\b`, "i");

/** The same document announced through the in-container FILE SERVER —
 *  /preview/<container>/<port>/<relpath> — which agents commonly hand out as
 *  the download link. The fileserver is rooted at /workspace, so <relpath>
 *  maps straight back onto a workspace path. Restricted to the file-server
 *  port: an office path on an app's own port is that app's business. */
const FILESERVER_DOC_RE = new RegExp(
  `\\/preview\\/[\\w.-]+\\/(\\d{2,5})\\/([^\\s"'\`)\\]>*,;?#]+\\.(?:${OFFICE_EXTS}))\\b`, "i");

function fileServerPort(): number {
  return (typeof window !== "undefined"
    && (window as unknown as { __VONZIO_FILE_SERVER_PORT?: number }).__VONZIO_FILE_SERVER_PORT) || 8765;
}

function decodeMaybe(path: string): string {
  // Href sources arrive percent-encoded ("Account%20Closure.docx") — store
  // the decoded workspace path; the tab re-encodes when building URLs.
  if (path.includes("%")) {
    try { return decodeURIComponent(path); } catch { /* malformed — use as-is */ }
  }
  return path;
}

/** Extract the first displayable office-document path mentioned in text,
 *  normalized to its /workspace/... form. Deliberately excludes bare .pdf —
 *  agents READ pdfs all the time; auto-opening on every mention would hijack
 *  the deck. (Raw pdfs still open via explicit clicks in Files/chat.) */
export function extractOfficeDocPath(text: string): string | null {
  const m = text.match(DOC_PATH_RE);
  if (m) return decodeMaybe(m[1]);
  const fs = text.match(FILESERVER_DOC_RE);
  if (fs && parseInt(fs[1], 10) === fileServerPort()) {
    return decodeMaybe(`/workspace/${fs[2]}`);
  }
  return null;
}

export const OPEN_DOCUMENT_EVENT = "vonzio:open-document";

/** Ask the workspace page to open a document in the deck — usable from any
 *  depth (chat markdown links, file rows) without prop-drilling. */
export function openDocumentInDeck(path: string) {
  window.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_EVENT, { detail: { path } }));
}

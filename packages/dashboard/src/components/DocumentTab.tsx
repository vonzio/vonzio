import { useEffect, useState } from "react";
import { Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { PdfViewer } from "./PdfViewer.js";

/**
 * Document deck tab (#368): read-only rendered preview of office files the
 * agent creates or edits. docx/pptx (and legacy/odf friends) arrive as PDF —
 * converted inside the agent container by /app/docpreview.sh — and render
 * through the existing pdf.js viewer; xlsx/xls arrive as an escaped HTML
 * table shown in a sandboxed iframe. Raw PDFs skip conversion and stream
 * straight from the files route.
 */

import { documentKind } from "./document-utils.js";

interface Props {
  containerId: string | null;
  /** /workspace/... path of the document being shown. */
  filePath: string | null;
  /** Bump to reconvert + re-render after the agent edits the file. */
  refreshTrigger?: number;
}

export function DocumentTab({ containerId, filePath, refreshTrigger = 0 }: Props) {
  const shortId = containerId ? containerId.slice(0, 12) : null;
  const kind = filePath ? documentKind(filePath) : null;
  const encodedPath = filePath
    ? filePath.split("/").map(encodeURIComponent).join("/")
    : null;
  // ?v= busts pdf.js/iframe URL identity on refresh; the server never caches
  // (no-store) and reconverts only when the file's mtime actually moved.
  const url = shortId && encodedPath && kind
    ? kind === "pdf-raw"
      ? `/preview/${shortId}/files${encodedPath}?v=${refreshTrigger}`
      : `/preview/${shortId}/docpreview${encodedPath}?v=${refreshTrigger}`
    : null;
  const downloadUrl = shortId && encodedPath ? `/preview/${shortId}/files${encodedPath}` : null;
  const name = filePath?.split("/").pop() ?? "";

  if (!url || !kind) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6" style={{ color: "var(--vz-muted)" }}>
        <FileText className="w-8 h-8" style={{ color: "var(--vz-muted-2)" }} />
        <p className="text-sm">No document yet — when the agent creates one, it opens here.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{ height: 36, borderBottom: "1px solid var(--vz-border)" }}
      >
        <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: "var(--vz-sodium)" }} />
        <span className="text-xs truncate flex-1" style={{ color: "var(--vz-ink)" }} title={filePath ?? undefined}>{name}</span>
        {downloadUrl && (
          <a href={downloadUrl} download={name} className="vz-action-btn" title="Download" style={{ width: 24, height: 24 }}>
            <Download size={13} />
          </a>
        )}
      </div>
      {kind === "html-converted"
        ? <HtmlDocView url={url} />
        : <PdfDocView url={url} downloadUrl={downloadUrl} name={name} />}
    </div>
  );
}

/** Fetch the (converted) PDF ourselves so a failure shows a human message +
 *  download fallback instead of pdf.js's raw "Unexpected server response"
 *  string; the blob then feeds the viewer. */
function PdfDocView({ url, downloadUrl, name }: { url: string; downloadUrl: string | null; name: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setBlobUrl(null);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(res.status === 422
            ? "This document couldn't be rendered — it may not exist yet, or its format isn't convertible."
            : res.status === 404
              ? "File not found in the workspace."
              : `Preview failed (${res.status}).`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Preview failed"); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: "var(--vz-muted)" }}>
        <FileText className="w-6 h-6" style={{ color: "var(--vz-muted-2)" }} />
        <p className="text-sm" style={{ maxWidth: 340 }}>{error}</p>
        {downloadUrl && (
          <a href={downloadUrl} download={name} className="text-sm" style={{ color: "var(--vz-sodium)" }}>
            Download the file instead
          </a>
        )}
      </div>
    );
  }
  if (!blobUrl) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--vz-muted-2)" }} />
      </div>
    );
  }
  return <div className="flex-1 min-h-0 overflow-auto"><PdfViewer url={blobUrl} /></div>;
}

/** Spreadsheet render: fetch the server-generated (fully escaped) HTML and
 *  show it in a no-scripts sandbox, same trust posture as FilePreviewModal's
 *  HTML view. */
function HtmlDocView({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        return res.text();
      })
      .then((text) => { if (!cancelled) setHtml(text); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Preview failed"); });
    return () => { cancelled = true; };
  }, [url]);

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6" style={{ color: "var(--vz-muted)" }}>
        <RefreshCw className="w-5 h-5" style={{ color: "var(--vz-muted-2)" }} />
        <p className="text-sm">{error}</p>
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--vz-muted-2)" }} />
      </div>
    );
  }
  return (
    <iframe
      title="Spreadsheet preview"
      sandbox=""
      srcDoc={html}
      className="flex-1 w-full"
      style={{ border: 0, background: "#fff" }}
    />
  );
}

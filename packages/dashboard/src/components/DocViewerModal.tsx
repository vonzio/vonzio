import { useEffect } from "react";
import { X, Download, ExternalLink } from "lucide-react";
import { PdfViewer } from "./PdfViewer.js";

export interface DocViewerTarget {
  url: string;
  mediaType: string;
  name: string;
  /** Optional PDF page to open at (browser PDF viewer #page= fragment). */
  page?: number;
}

/**
 * Lightweight viewer for a knowledge document — PDF in the browser's native
 * viewer (with optional #page jump), images inline, everything else offered as
 * a download. Same-origin URL, so the session cookie rides along.
 */
export function DocViewerModal({ target, onClose }: { target: DocViewerTarget; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isPdf = target.mediaType === "application/pdf" || target.name.toLowerCase().endsWith(".pdf");
  const isImage = target.mediaType.startsWith("image/");

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="flex flex-col flex-1 m-4 rounded-lg overflow-hidden"
        style={{ background: "var(--vz-page)", border: "1px solid var(--vz-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-3 px-4 shrink-0"
          style={{ height: 44, borderBottom: "1px solid var(--vz-border)" }}
        >
          <span className="text-sm font-medium truncate" style={{ color: "var(--vz-ink)" }}>
            {target.name}{isPdf && target.page ? ` · p.${target.page}` : ""}
          </span>
          <div className="flex items-center gap-1 ml-auto">
            <a href={target.url} target="_blank" rel="noopener noreferrer" className="vz-action-btn" title="Open in new tab">
              <ExternalLink size={14} />
            </a>
            <a href={target.url} download={target.name} className="vz-action-btn" title="Download">
              <Download size={14} />
            </a>
            <button onClick={onClose} className="vz-action-btn" title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto" style={{ background: "var(--vz-mute)" }}>
          {isPdf ? (
            <PdfViewer url={target.url} initialPage={target.page} />
          ) : isImage ? (
            <img src={target.url} alt={target.name} className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="text-center p-8" style={{ color: "var(--vz-muted)" }}>
              <p className="text-sm mb-3">No inline preview for this file type.</p>
              <a href={target.url} download={target.name} className="vz-btn vz-btn--primary" style={{ display: "inline-flex", gap: 6 }}>
                <Download size={14} /> Download {target.name}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// Vite resolves this to the bundled worker asset URL.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Single-page PDF viewer built on pdf.js. Renders one page to a canvas at a
 * time — so a 200+ page / tens-of-MB manual stays responsive — with reliable
 * programmatic page jumps (unlike the browser's embedded `#page`, which is
 * flaky in an iframe). `initialPage` lands the viewer on a cited page.
 */
export function PdfViewer({ url, initialPage = 1 }: { url: string; initialPage?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(Math.max(1, initialPage));
  const [scale, setScale] = useState(1.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the document once per URL.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const task = pdfjsLib.getDocument({ url, withCredentials: true });
    task.promise.then((doc) => {
      if (cancelled) { void task.destroy(); return; }
      setPdf(doc);
      setNumPages(doc.numPages);
      setPage((p) => Math.min(Math.max(1, p), doc.numPages));
      setLoading(false);
    }).catch((e: unknown) => {
      if (!cancelled) { setError(e instanceof Error ? e.message : "Failed to load PDF"); setLoading(false); }
    });
    return () => { cancelled = true; void task.destroy(); };
  }, [url]);

  // Render the current page whenever it (or zoom) changes.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      try {
        const pg = await pdf.getPage(page);
        if (cancelled || !canvasRef.current) return;
        const viewport = pg.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTaskRef.current?.cancel();
        const task = pg.render({ canvas, canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        /* render cancelled (page/scale changed) or page error — ignore */
      }
    })();
    // Cancel an in-flight render so the pdf.js worker isn't left rendering a
    // page we've navigated away from (or after unmount).
    return () => { cancelled = true; renderTaskRef.current?.cancel(); };
  }, [pdf, page, scale]);

  const go = useCallback((n: number) => setPage((p) => {
    const target = Math.min(Math.max(1, n), numPages || 1);
    return Number.isFinite(target) ? target : p;
  }), [numPages]);

  return (
    <div className="flex flex-col w-full h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-center gap-2 px-3 shrink-0"
        style={{ height: 38, borderBottom: "1px solid var(--vz-border)", background: "var(--vz-card)" }}
      >
        <button className="vz-action-btn" onClick={() => go(page - 1)} disabled={page <= 1} title="Previous page">
          <ChevronLeft size={15} />
        </button>
        <div className="flex items-center gap-1" style={{ fontSize: 12, color: "var(--vz-ink-3)" }}>
          <input
            type="number"
            value={page}
            min={1}
            max={numPages || 1}
            onChange={(e) => go(parseInt(e.target.value, 10))}
            className="text-center"
            style={{ width: 48, background: "var(--vz-mute)", border: "1px solid var(--vz-border)", borderRadius: 4, padding: "1px 4px", color: "var(--vz-ink)" }}
          />
          <span style={{ fontFamily: "var(--vz-font-mono)" }}>/ {numPages || "—"}</span>
        </div>
        <button className="vz-action-btn" onClick={() => go(page + 1)} disabled={page >= numPages} title="Next page">
          <ChevronRight size={15} />
        </button>
        <span style={{ width: 1, height: 18, background: "var(--vz-border)", margin: "0 4px" }} />
        <button className="vz-action-btn" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} title="Zoom out">
          <ZoomOut size={15} />
        </button>
        <span style={{ fontSize: 11, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", width: 38, textAlign: "center" }}>
          {Math.round(scale * 100)}%
        </span>
        <button className="vz-action-btn" onClick={() => setScale((s) => Math.min(3, s + 0.2))} title="Zoom in">
          <ZoomIn size={15} />
        </button>
      </div>

      {/* Page canvas */}
      <div className="flex-1 min-h-0 overflow-auto flex justify-center p-4" style={{ background: "var(--vz-mute)" }}>
        {loading ? (
          <div className="flex items-center gap-2 self-center" style={{ color: "var(--vz-muted)" }}>
            <Loader2 className="w-4 h-4 animate-spin" /> <span className="text-sm">Loading PDF…</span>
          </div>
        ) : error ? (
          <div className="self-center text-sm" style={{ color: "var(--vz-fail)" }}>{error}</div>
        ) : (
          <canvas ref={canvasRef} className="self-start shadow-md" style={{ background: "#fff" }} />
        )}
      </div>
    </div>
  );
}

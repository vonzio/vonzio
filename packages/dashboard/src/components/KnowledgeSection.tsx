import { useEffect, useRef, useState } from "react";
import { FileText, Trash2, Upload, Loader2 } from "lucide-react";
import {
  fetchProfileDocuments, uploadProfileDocument, deleteProfileDocument,
  fetchWorkspaceDocuments, uploadWorkspaceDocument, deleteWorkspaceDocument,
  profileDocumentRawUrl, workspaceDocumentRawUrl,
  type ProfileDocument,
} from "../api/client.js";
import { DocViewerModal, type DocViewerTarget } from "./DocViewerModal.js";

// Per-file cap, published by the server in /api/config (MAX_DOCUMENT_MB).
// Read at render (not module load) so it reflects config once fetched; falls
// back to 100 MB (the server default) until then.
function maxDocBytes(): number {
  const mb = (typeof window !== "undefined" && (window as unknown as { __VONZIO_MAX_DOCUMENT_MB?: number }).__VONZIO_MAX_DOCUMENT_MB) || 100;
  return mb * 1024 * 1024;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a File as base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Knowledge documents, mounted read-only at /knowledge for the agent to read on
 * the fly (Read/Grep/Glob — no embeddings). Two scopes:
 *   - scope "agent"     → shared across every chat this agent runs (keyed by profileId)
 *   - scope "workspace" → only this conversation (keyed by sessionId)
 */
export function KnowledgeSection(
  { scope = "agent", profileId, sessionId }:
  { scope?: "agent" | "workspace"; profileId?: string | null; sessionId?: string | null },
) {
  const isWorkspace = scope === "workspace";
  const id = isWorkspace ? (sessionId ?? null) : (profileId ?? null);
  const fetchDocs = (i: string) => (isWorkspace ? fetchWorkspaceDocuments(i) : fetchProfileDocuments(i));
  const uploadDoc = (i: string, body: { name: string; media_type: string; content_b64: string }) =>
    isWorkspace ? uploadWorkspaceDocument(i, body) : uploadProfileDocument(i, body);
  const deleteDoc = (i: string, docId: string) =>
    isWorkspace ? deleteWorkspaceDocument(i, docId) : deleteProfileDocument(i, docId);
  const rawUrl = (docId: string) =>
    isWorkspace ? workspaceDocumentRawUrl(id!, docId) : profileDocumentRawUrl(id!, docId);

  const [docs, setDocs] = useState<ProfileDocument[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [viewer, setViewer] = useState<DocViewerTarget | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id) return;
    fetchDocs(id).then(setDocs).catch(() => setDocs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isWorkspace]);

  if (!id) {
    return (
      <p style={{ fontSize: 13, color: "var(--vz-muted)" }}>
        Save the agent first, then add reference documents here — they'll be available to every
        chat this agent runs.
      </p>
    );
  }

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Reject oversized files client-side so we never fire a doomed request
    // (the server would 413/400). Clear, per-file feedback.
    const list = Array.from(files);
    const tooBig = list.filter((f) => f.size > maxDocBytes());
    if (tooBig.length > 0) {
      setError(
        `${tooBig.map((f) => `${f.name} (${fmtSize(f.size)})`).join(", ")} — over the ${fmtSize(maxDocBytes())} per-file limit.`,
      );
    }
    const ok = list.filter((f) => f.size <= maxDocBytes());
    if (ok.length === 0) {
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    if (tooBig.length === 0) setError(null);
    try {
      for (const file of ok) {
        const content_b64 = await fileToBase64(file);
        await uploadDoc(id, {
          name: file.name,
          media_type: file.type || "application/octet-stream",
          content_b64,
        });
      }
      setDocs(await fetchDocs(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (docId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteDoc(id, docId);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== docId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ fontSize: 12.5, color: "var(--vz-muted)", margin: 0 }}>
        {isWorkspace
          ? "Reference documents available only to this conversation"
          : "Reference documents shared across every chat this agent runs"}
        , mounted read-only at <code>/knowledge</code>. The agent reads them on demand (PDFs, text,
        code, markdown…). Up to {fmtSize(maxDocBytes())} per file.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void upload(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "16px", borderRadius: "var(--vz-radius-sm)", cursor: "pointer",
          border: `1px dashed ${dragOver ? "var(--vz-sodium)" : "var(--vz-border)"}`,
          background: dragOver ? "var(--vz-sodium-08)" : "var(--vz-mute)",
          color: "var(--vz-muted)", fontSize: 13,
        }}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        <span>{busy ? "Uploading…" : `Drop files here or click to upload · max ${fmtSize(maxDocBytes())}`}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--vz-fail)", margin: 0 }}>{error}</p>}

      {/* List */}
      {docs === null ? (
        <p style={{ fontSize: 12.5, color: "var(--vz-muted-2)" }}>Loading…</p>
      ) : docs.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--vz-muted-2)" }}>No documents yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {docs.map((d) => (
            <div
              key={d.id}
              className="group/doc"
              onClick={() => setViewer({ url: rawUrl(d.id), mediaType: d.media_type, name: d.name })}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderRadius: "var(--vz-radius-sm)",
                border: "1px solid var(--vz-border)", background: "var(--vz-card)",
                fontSize: 13, cursor: "pointer",
              }}
              title={`View ${d.name}`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
              <span className="flex-1 truncate" style={{ color: "var(--vz-ink)" }}>{d.name}</span>
              <span style={{ fontSize: 11, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                {fmtSize(d.size_bytes)}
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void remove(d.id); }}
                disabled={busy}
                className="vz-action-btn vz-action-btn--danger opacity-0 group-hover/doc:opacity-100 transition-opacity"
                style={{ width: 22, height: 22 }}
                title="Remove document"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {viewer && <DocViewerModal target={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

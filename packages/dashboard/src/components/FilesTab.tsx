import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, File as FileIcon, Folder, Download, Trash2, Upload, Plus, ChevronRight, Check } from "lucide-react";
import { fetchWorkspaceFiles, uploadFiles, deleteFile, workspaceArchiveUrl, type FileEntry } from "../api/client.js";
import { FilePreviewModal } from "./FilePreviewModal.js";

function humanSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

interface Props {
  workspaceId: string;
  containerId: string | null;
}

export function FilesTab({ workspaceId, containerId }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [currentPath, setCurrentPath] = useState("/workspace/");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset selection whenever the directory changes — selected names refer to entries here.
  useEffect(() => { setSelected(new Set()); }, [currentPath]);

  function toggleSelect(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function clearSelection() { setSelected(new Set()); }

  function downloadCurrentFolder() {
    const archiveName = currentPath.replace(/\/$/, "").split("/").pop() || "workspace";
    triggerDownload(workspaceArchiveUrl(workspaceId, [currentPath], archiveName));
  }

  function downloadSelection() {
    const paths = Array.from(selected).map((name) => `${currentPath}${name}`);
    if (paths.length === 0) return;
    const baseFolder = currentPath.replace(/\/$/, "").split("/").pop() || "workspace";
    const archiveName = paths.length === 1
      ? (selected.values().next().value as string)
      : `${baseFolder}-${paths.length}-items`;
    triggerDownload(workspaceArchiveUrl(workspaceId, paths, archiveName));
  }

  async function deleteSelection() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} item${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    for (const name of selected) {
      try { await deleteFile(workspaceId, `${currentPath}${name}`); }
      catch (err) { console.error("Delete failed:", name, err); }
    }
    clearSelection();
    await load();
  }

  const load = useCallback(async () => {
    if (!containerId) return;
    setLoading(true);
    try {
      const data = await fetchWorkspaceFiles(workspaceId, currentPath);
      setFiles(data.files);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, containerId, currentPath]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (!containerId) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load, containerId]);

  // Build breadcrumb segments from currentPath
  const breadcrumbSegments = (() => {
    // Strip the /workspace/ prefix, keep "www" and below
    const relative = currentPath.replace(/^\/workspace\//, "").replace(/\/$/, "");
    if (!relative) return [];
    return relative.split("/");
  })();

  async function handleUpload(fileList: FileList | File[]) {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setUploading(true);
    try {
      await uploadFiles(workspaceId, arr);
      await load();
    } catch (err) {
      console.error("Upload failed:", err);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(fileName: string) {
    if (!confirm(`Delete ${fileName}? This cannot be undone.`)) return;
    try {
      await deleteFile(workspaceId, `${currentPath}${fileName}`);
      await load();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  // Read all entries from a directory reader (handles batching)
  function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve) => {
      const all: FileSystemEntry[] = [];
      function readBatch() {
        reader.readEntries((entries) => {
          if (entries.length === 0) {
            resolve(all);
          } else {
            all.push(...entries);
            readBatch(); // readEntries may return batches of 100
          }
        }, () => resolve(all));
      }
      readBatch();
    });
  }

  // Recursively read directory entries from a drag-and-drop
  async function readEntryRecursive(entry: FileSystemEntry, basePath: string): Promise<globalThis.File[]> {
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file((file) => {
          const relativePath = basePath ? `${basePath}/${file.name}` : file.name;
          const renamedFile = new globalThis.File([file], relativePath, { type: file.type });
          resolve([renamedFile]);
        }, () => resolve([]));
      });
    }
    if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await readAllEntries(dirReader);
      const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      const allFiles: globalThis.File[] = [];
      for (const child of entries) {
        const files = await readEntryRecursive(child, dirPath);
        allFiles.push(...files);
      }
      return allFiles;
    }
    return [];
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    // Try to read directory entries (for folder drops)
    const items = e.dataTransfer.items;
    let hasDirectories = false;
    if (items) {
      const allFiles: globalThis.File[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          hasDirectories = true;
          const files = await readEntryRecursive(entry, "");
          allFiles.push(...files);
        } else if (entry?.isFile) {
          const files = await readEntryRecursive(entry, "");
          allFiles.push(...files);
        }
      }
      if (allFiles.length > 0) {
        handleUpload(allFiles);
        return;
      }
    }

    // Fallback: regular file drop
    if (!hasDirectories) {
      handleUpload(e.dataTransfer.files);
    }
  }

  if (!containerId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--vz-muted-2)" }}>
        No container running
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 text-xs"
        style={{ borderBottom: "1px solid var(--vz-border)", color: "var(--vz-muted)" }}
      >
        <button
          onClick={() => setCurrentPath("/workspace/")}
          className={`truncate font-mono ${currentPath !== "/workspace/" ? "cursor-pointer" : ""}`}
          style={currentPath !== "/workspace/" ? { color: "var(--vz-muted)" } : undefined}
          onMouseEnter={(e) => { if (currentPath !== "/workspace/") (e.currentTarget as HTMLElement).style.color = "var(--vz-sodium)"; }}
          onMouseLeave={(e) => { if (currentPath !== "/workspace/") (e.currentTarget as HTMLElement).style.color = "var(--vz-muted)"; }}
        >
          {currentPath}
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          {uploading && <span className="animate-pulse" style={{ color: "var(--vz-sodium)" }}>Uploading...</span>}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="vz-action-btn"
            style={{ width: 22, height: 22 }}
            title="Upload files"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={downloadCurrentFolder}
            disabled={files.length === 0}
            className="vz-action-btn"
            style={{ width: 22, height: 22 }}
            title="Download this folder as .tar"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="vz-action-btn"
            style={{ width: 22, height: 22 }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Selection bar — appears when one or more rows are selected */}
      {selected.size > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs"
          style={{
            background: "var(--vz-sodium-08)",
            borderBottom: "1px solid var(--vz-sodium-25)",
            color: "var(--vz-ink-2)",
          }}
        >
          <span style={{ fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em", color: "var(--vz-sodium)" }}>
            {selected.size} selected
          </span>
          <button
            onClick={clearSelection}
            className="ml-auto"
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11,
              color: "var(--vz-muted)",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-ink)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-muted)"; }}
          >
            clear
          </button>
          <button
            onClick={downloadSelection}
            className="vz-action-btn"
            style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 11 }}
            title="Download selection as .tar"
          >
            <Download className="w-3 h-3" />
            <span>Download</span>
          </button>
          <button
            onClick={deleteSelection}
            className="vz-action-btn vz-action-btn--danger"
            style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 11 }}
            title="Delete selection"
          >
            <Trash2 className="w-3 h-3" />
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Breadcrumb bar */}
      {breadcrumbSegments.length > 0 && (
        <div
          className="flex items-center gap-0.5 px-3 py-1 text-xs overflow-x-auto"
          style={{ borderBottom: "1px solid var(--vz-border)", color: "var(--vz-muted)" }}
        >
          <button
            onClick={() => setCurrentPath("/workspace/")}
            className="cursor-pointer whitespace-nowrap"
            style={{ color: "var(--vz-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-sodium)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-muted)"; }}
          >
            workspace
          </button>
          {breadcrumbSegments.map((seg, i) => {
            const isLast = i === breadcrumbSegments.length - 1;
            const targetPath = "/workspace/" + breadcrumbSegments.slice(0, i + 1).join("/") + "/";
            return (
              <span key={i} className="flex items-center gap-0.5 whitespace-nowrap">
                <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: "var(--vz-muted-2)" }} />
                {isLast ? (
                  <span className="font-medium" style={{ color: "var(--vz-ink)" }}>{seg}</span>
                ) : (
                  <button
                    onClick={() => setCurrentPath(targetPath)}
                    className="cursor-pointer"
                    style={{ color: "var(--vz-muted)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-sodium)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--vz-muted)"; }}
                  >
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) handleUpload(e.target.files); e.target.value = ""; }}
      />

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {files.length === 0 && !dragOver ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2 p-4 cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-8 h-8" style={{ color: "var(--vz-muted-2)" }} />
            <p className="text-sm" style={{ color: "var(--vz-muted)" }}>Drop files here or click to upload</p>
          </div>
        ) : (
          <div>
            {files.map((f, i) => {
              // Build the download path by stripping the leading "/" from currentPath
              const downloadPath = `/preview/${containerId}/files${currentPath}${f.name}`;
              const isSelected = selected.has(f.name);
              const showCheck = selected.size > 0; // sticky-visible once selection exists
              return (
                <div
                  key={f.name}
                  className="group flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors"
                  style={{
                    color: "var(--vz-ink-2)",
                    borderTop: i === 0 ? "0" : "1px solid var(--vz-border)",
                    background: isSelected ? "var(--vz-sodium-08)" : "transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = isSelected ? "var(--vz-sodium-08)" : "transparent";
                  }}
                  onClick={() => {
                    if (f.type === "directory") {
                      setCurrentPath(currentPath + f.name + "/");
                    } else {
                      setPreviewFile(f);
                    }
                  }}
                >
                  {/* Checkbox / icon — checkbox slot replaces icon when row is hovered or any selection exists */}
                  <button
                    type="button"
                    onClick={(e) => toggleSelect(f.name, e)}
                    className={showCheck || isSelected ? "" : "group-hover:flex hidden"}
                    style={{
                      width: 16, height: 16, borderRadius: 4,
                      display: showCheck || isSelected ? "grid" : undefined,
                      placeItems: "center",
                      flexShrink: 0,
                      background: isSelected ? "var(--vz-sodium)" : "transparent",
                      border: `1.5px solid ${isSelected ? "var(--vz-sodium)" : "var(--vz-border-strong)"}`,
                      color: "#fff",
                      cursor: "pointer",
                      transition: "background var(--vz-fast) var(--vz-ease), border-color var(--vz-fast) var(--vz-ease)",
                    }}
                    title={isSelected ? "Deselect" : "Select"}
                    aria-pressed={isSelected}
                  >
                    {isSelected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                  </button>
                  {/* Icon — hidden when checkbox is showing */}
                  <span className={showCheck || isSelected ? "hidden" : "group-hover:hidden inline-flex"}>
                    {f.type === "directory"
                      ? <Folder className="w-4 h-4 flex-shrink-0" style={{ color: "var(--vz-sodium)" }} />
                      : <FileIcon className="w-4 h-4 flex-shrink-0" style={{ color: "var(--vz-muted-2)" }} />
                    }
                  </span>
                  <span className="flex-1 truncate">{f.name}</span>
                  <span
                    className="text-xs group-hover:hidden font-mono"
                    style={{ color: "var(--vz-muted-2)" }}
                  >
                    {f.type === "file" ? humanSize(f.size) : ""}
                  </span>

                  {/* Hover actions — only when no selection is active */}
                  {selected.size === 0 && (
                    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                      {f.type === "file" ? (
                        <a
                          href={downloadPath}
                          download={f.name}
                          onClick={(e) => e.stopPropagation()}
                          className="vz-action-btn"
                          style={{ width: 22, height: 22 }}
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            triggerDownload(workspaceArchiveUrl(workspaceId, [`${currentPath}${f.name}`], f.name));
                          }}
                          className="vz-action-btn"
                          style={{ width: 22, height: 22 }}
                          title="Download folder as .tar"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {f.type === "file" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(f.name); }}
                          className="vz-action-btn vz-action-btn--danger"
                          style={{ width: 22, height: 22 }}
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div
          className="absolute inset-0 border-2 border-dashed rounded-lg flex items-center justify-center z-10"
          style={{
            background: "var(--vz-sodium-08)",
            borderColor: "var(--vz-sodium)",
          }}
        >
          <div className="text-center">
            <Upload className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--vz-sodium)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--vz-sodium)" }}>Drop files to upload</p>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewFile && containerId && (
        <FilePreviewModal
          file={previewFile}
          containerId={containerId}
          basePath={currentPath}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}

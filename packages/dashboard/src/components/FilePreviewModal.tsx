import { useState, useEffect } from "react";
import { X, Download, FileText, Code, Eye } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileEntry } from "../api/client.js";
import { CodeBlock, langFromFilename } from "./CodeBlock.js";
import { useTheme } from "../hooks/useTheme.js";

const TEXT_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".json", ".css", ".txt",
  ".py", ".rb", ".go", ".rs", ".java", ".sh", ".bash", ".yaml", ".yml",
  ".toml", ".xml", ".sql", ".env", ".gitignore", ".dockerfile",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);
const RENDERABLE_EXTENSIONS = new Set([".html", ".md", ".csv"]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

interface Props {
  file: FileEntry;
  containerId: string;
  basePath?: string;
  onClose: () => void;
}

export function FilePreviewModal({ file, containerId, basePath = "/workspace/", onClose }: Props) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");

  const ext = getExt(file.name);
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const isRenderable = RENDERABLE_EXTENSIONS.has(ext);
  const isText = TEXT_EXTENSIONS.has(ext) || isRenderable;
  const filePath = `${basePath}${file.name}`;
  const downloadUrl = `/preview/${containerId}/files${filePath}`;

  useEffect(() => {
    if (!isText) return;
    setLoading(true);
    fetch(downloadUrl, { credentials: "include" })
      .then((res) => res.text())
      .then((text) => { setTextContent(text); setLoading(false); })
      .catch(() => { setTextContent("Failed to load file"); setLoading(false); });
  }, [downloadUrl, isText]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--vz-page)" }}
    >
      {/* Header — 44px to match WorkspaceHeader/RightPanel tabs */}
      <div
        className="flex items-center justify-between gap-3 px-4 shrink-0"
        style={{
          height: 44,
          borderBottom: "1px solid var(--vz-border)",
          background: "var(--vz-page)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
          <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: "var(--vz-ink)" }}>{file.name}</span>
          <span
            className="font-mono shrink-0"
            style={{
              fontSize: 11,
              color: "var(--vz-muted-2)",
              background: "var(--vz-mute)",
              border: "1px solid var(--vz-border)",
              padding: "2px 8px",
              borderRadius: 5,
              letterSpacing: "0.02em",
            }}
          >
            {humanSize(file.size)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRenderable && textContent && (
            <button
              onClick={() => setViewMode(viewMode === "rendered" ? "source" : "rendered")}
              className="vz-action-btn"
              style={{ width: "auto", padding: "0 10px", gap: 5, fontSize: 12 }}
              title={viewMode === "rendered" ? "View source" : "View rendered"}
            >
              {viewMode === "rendered" ? <Code className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{viewMode === "rendered" ? "Source" : "Rendered"}</span>
            </button>
          )}
          <a
            href={downloadUrl}
            download={file.name}
            className="vz-action-btn"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </a>
          <button
            onClick={onClose}
            className="vz-action-btn"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto flex flex-col" style={{ background: "var(--vz-page)" }}>
        {isImage && (
          <div className="flex items-center justify-center p-6 flex-1">
            <img
              src={downloadUrl}
              alt={file.name}
              className="max-w-full max-h-full object-contain rounded"
              style={{ border: "1px solid var(--vz-border)" }}
            />
          </div>
        )}
        {isText && (
          <div className="p-6 flex-1 flex flex-col max-w-5xl w-full mx-auto">
            {loading ? (
              <p className="text-sm" style={{ color: "var(--vz-muted-2)" }}>Loading…</p>
            ) : isRenderable && viewMode === "rendered" && textContent ? (
              <RenderedView ext={ext} content={textContent} downloadUrl={downloadUrl} />
            ) : (
              <CodeBlock code={textContent ?? ""} lang={langFromFilename(file.name)} />
            )}
          </div>
        )}
        {!isImage && !isText && (
          <div className="flex flex-col items-center justify-center flex-1 gap-3">
            <FileText className="w-12 h-12" style={{ color: "var(--vz-muted-2)" }} />
            <p className="text-sm" style={{ color: "var(--vz-ink-2)" }}>{file.name}</p>
            <p className="text-xs" style={{ color: "var(--vz-muted-2)" }}>{humanSize(file.size)}</p>
            <a
              href={downloadUrl}
              download={file.name}
              className="mt-2 inline-flex items-center gap-2"
              style={{
                background: "var(--vz-sodium)",
                color: "#fff",
                padding: "8px 16px",
                borderRadius: "var(--vz-radius-sm)",
                fontFamily: "var(--vz-font-mono)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              <Download className="w-3.5 h-3.5" />
              Download file
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function RenderedView({ ext, content, downloadUrl: _downloadUrl }: { ext: string; content: string; downloadUrl: string }) {
  const { surface } = useTheme();
  const proseClass = surface === "paper" ? "prose" : "prose prose-invert";
  if (ext === ".md") {
    return (
      <div
        className={`${proseClass} prose-sm max-w-none [&_a]:text-[color:var(--vz-sodium)] [&_a]:underline [&_code]:text-[color:var(--vz-sodium)] [&_pre_code]:text-[color:var(--vz-ink-2)] [&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-[var(--vz-mute)] prose-pre:border prose-pre:border-[var(--vz-border)] [&_h1]:text-[color:var(--vz-ink)] [&_h2]:text-[color:var(--vz-ink)] [&_h3]:text-[color:var(--vz-ink)] [&_h4]:text-[color:var(--vz-ink)] [&_strong]:text-[color:var(--vz-ink)] [&_blockquote]:not-italic [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--vz-sodium)] [&_blockquote]:bg-[var(--vz-mute)] [&_blockquote]:rounded-r-md [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote]:my-3 [&_blockquote]:text-[color:var(--vz-ink-2)] [&_blockquote_p]:my-1 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none`}
        style={{ color: "var(--vz-ink-2)" }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre: ({ children }) => {
              // Route fenced ```lang blocks through the syntax-highlighted CodeBlock
              const child = Array.isArray(children) ? children[0] : children;
              if (child && typeof child === "object" && "props" in child) {
                const cls = (child.props?.className ?? "") as string;
                const code = String(child.props?.children ?? "").replace(/\n$/, "");
                const lang = cls.startsWith("language-") ? cls.slice("language-".length) : undefined;
                return <CodeBlock code={code} lang={lang} />;
              }
              return <CodeBlock code={String(children ?? "")} />;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  if (ext === ".html") {
    return (
      <iframe
        srcDoc={content}
        className="w-full flex-1 min-h-[60vh]"
        style={{
          border: "1px solid var(--vz-border)",
          borderRadius: "var(--vz-radius-md)",
          background: "#fff",
        }}
        sandbox="allow-scripts"
        title="HTML preview"
      />
    );
  }

  if (ext === ".csv") {
    return <CsvTable content={content} />;
  }

  return null;
}

function CsvTable({ content }: { content: string }) {
  const rows = parseCsv(content);
  if (rows.length === 0) return <p className="text-sm" style={{ color: "var(--vz-muted-2)" }}>Empty CSV</p>;

  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div
      className="overflow-auto max-h-[70vh]"
      style={{
        border: "1px solid var(--vz-border)",
        borderRadius: "var(--vz-radius-md)",
      }}
    >
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left whitespace-nowrap"
                style={{
                  background: "var(--vz-mute)",
                  borderBottom: "1px solid var(--vz-border)",
                  color: "var(--vz-ink)",
                  fontFamily: "var(--vz-font-mono)",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  fontSize: 10.5,
                }}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr
              key={ri}
              className="transition-colors"
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-3 py-1.5 whitespace-nowrap"
                  style={{
                    borderTop: "1px solid var(--vz-border)",
                    color: "var(--vz-ink-2)",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(cell);
        cell = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        current.push(cell);
        cell = "";
        if (current.some((c) => c)) rows.push(current);
        current = [];
        if (ch === "\r") i++;
      } else {
        cell += ch;
      }
    }
  }
  if (cell || current.length > 0) {
    current.push(cell);
    if (current.some((c) => c)) rows.push(current);
  }
  return rows;
}

function humanSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

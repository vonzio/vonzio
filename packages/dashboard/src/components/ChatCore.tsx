/**
 * Shared chat components used by both Playground and ChatEmbed.
 * Extracted from Playground.tsx to avoid duplication.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, Loader2, Copy, Check, Trash2, FileText, FilePlus, FileEdit, Eye, Search, FolderSearch, Wrench, GitBranch, Download, Terminal, MessageCircleQuestion, Maximize2, Minimize2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import mermaid from "mermaid";
import { CodeBlock } from "./CodeBlock.js";

mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict", suppressErrorRendering: true });

// ─── Types ───────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool_use" | "tool_result";
  content: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  timestamp: Date;
  images?: string[]; // base64 data URLs for display
  files?: Array<{ name: string; type: "image" | "document" }>; // all attachment metadata
}

let msgId = 0;
export function nextId() { return `msg_${++msgId}`; }

// ─── Markdown ────────────────────────────────────────────────────────

/** Auto-linkify raw URLs that aren't already markdown links */
export function linkifyText(text: string): string {
  return text.replace(
    /(?<!\]\()(?<!\<)(https?:\/\/[^\s\)>\]]+?)(?=[*`\]>)\s]|$)/g,
    (url) => `[${url}](${url})`,
  );
}

// ─── Fullscreen Overlay ──────────────────────────────────────────────

function FullscreenOverlay({ title, actions, onClose, children }: {
  title?: string;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 shrink-0">
        {title && <span className="text-sm font-medium text-gray-700">{title}</span>}
        <div className="flex items-center gap-1 ml-auto">
          {actions}
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 cursor-pointer rounded-md hover:bg-gray-100" title="Exit fullscreen (Esc)">
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}

let mermaidSeq = 0;

/** Make mermaid's HTML-in-SVG output valid XML (close void elements like <br>) */
function sanitizeSvgXml(svg: string): string {
  return svg.replace(/<(br|hr|img|input|meta|link)(\s[^>]*)?\s*(?<!\/)>/gi, "<$1$2 />");
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const renderIdRef = useRef(0);
  const [svg, setSvg] = useState<string>("");
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userView, setUserView] = useState<"diagram" | "code" | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!code.trim() || isStreaming) return;
    const thisRender = ++renderIdRef.current;

    const timer = setTimeout(async () => {
      if (renderIdRef.current !== thisRender) return;
      try {
        const id = `mermaid-${++mermaidSeq}`;
        const result = await mermaid.render(id, code.trim());
        if (renderIdRef.current === thisRender) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (e) {
        if (renderIdRef.current === thisRender) {
          setError(e instanceof Error ? e.message : "Failed to render");
        }
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [code, isStreaming]);

  // While streaming, show code building up; once SVG is ready, flip to diagram.
  // User can override by clicking the tabs manually.
  const view = userView ?? (isStreaming ? "code" : svg ? "diagram" : "code");

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadSvg = () => {
    if (!svg) return;
    const clean = sanitizeSvgXml(svg);
    const blob = new Blob([clean], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diagram.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mr-auto">Mermaid</span>
        <div className="flex rounded-md border border-gray-200 overflow-hidden">
          <button
            onClick={() => setUserView("diagram")}
            className={`px-2 py-0.5 text-[10px] cursor-pointer transition-colors ${
              view === "diagram" ? "bg-white text-gray-700 font-medium" : "bg-gray-100 text-gray-400 hover:text-gray-600"
            }`}
          >
            Diagram
          </button>
          <button
            onClick={() => setUserView("code")}
            className={`px-2 py-0.5 text-[10px] cursor-pointer transition-colors ${
              view === "code" ? "bg-white text-gray-700 font-medium" : "bg-gray-100 text-gray-400 hover:text-gray-600"
            }`}
          >
            Code
          </button>
        </div>
        <button onClick={copyCode} className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer" title="Copy mermaid code">
          {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
        </button>
        <button onClick={downloadSvg} disabled={!svg} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 cursor-pointer" title="Download SVG">
          <Download className="w-3 h-3" />
        </button>
        <button onClick={() => setFullscreen(!fullscreen)} disabled={!svg} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 cursor-pointer" title="Enlarge">
          <Maximize2 className="w-3 h-3" />
        </button>
      </div>

      {/* Error banner — only shown after streaming is done and render failed */}
      {error && !isStreaming && (
        <div className="px-3 py-1.5 bg-red-50 border-b border-red-100 text-[10px] text-red-500">
          Render error: {error}
        </div>
      )}

      {/* Content */}
      {view === "diagram" ? (
        svg ? (
          <div className="bg-white p-4 overflow-x-auto [&>svg]:mx-auto" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="flex items-center justify-center py-8 text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            <span className="text-xs">Rendering diagram...</span>
          </div>
        )
      ) : (
        <pre className="bg-gray-50 p-3 text-xs overflow-x-auto max-h-64 overflow-y-auto font-mono"><code>{code}</code></pre>
      )}

      {/* Fullscreen overlay */}
      {fullscreen && svg && (
        <FullscreenOverlay
          title="Mermaid Diagram"
          actions={<>
            <button onClick={copyCode} className="p-1.5 text-gray-400 hover:text-gray-600 cursor-pointer rounded-md hover:bg-gray-100" title="Copy code">
              {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
            </button>
            <button onClick={downloadSvg} className="p-1.5 text-gray-400 hover:text-gray-600 cursor-pointer rounded-md hover:bg-gray-100" title="Download SVG">
              <Download className="w-4 h-4" />
            </button>
          </>}
          onClose={() => setFullscreen(false)}
        >
          <div className="h-full flex items-center justify-center [&>svg]:max-h-[calc(100vh-6rem)] [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        </FullscreenOverlay>
      )}
    </div>
  );
}

export function MarkdownContent({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const processed = useMemo(() => linkifyText(content), [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        a: ({ href, children, ...props }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--vz-sodium)",
              textDecoration: "underline",
              wordBreak: "break-all",
            }}
            {...props}
          >
            {children}
          </a>
        ),
        pre: ({ children }) => {
          // Intercept code blocks: extract the inner <code> child, then route
          // by language — mermaid renders as a diagram, everything else goes
          // through the syntax-highlighted CodeBlock with line numbers.
          const child = Array.isArray(children) ? children[0] : children;
          if (child && typeof child === "object" && "props" in child) {
            const cls = (child.props?.className ?? "") as string;
            const code = String(child.props?.children ?? "").replace(/\n$/, "");
            if (cls === "language-mermaid") {
              return <MermaidBlock code={code} isStreaming={isStreaming} />;
            }
            const lang = cls.startsWith("language-") ? cls.slice("language-".length) : undefined;
            return <CodeBlock code={code} lang={lang} />;
          }
          return <CodeBlock code={String(children ?? "")} />;
        },
        code: ({ className, children, ...props }) => {
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return <code className={className} {...props}>{children}</code>;
          }
          return (
            <code
              className="text-xs"
              style={{
                background: "var(--vz-mute)",
                border: "1px solid var(--vz-border)",
                color: "var(--vz-sodium)",
                borderRadius: 4,
                padding: "1px 5px",
                fontFamily: "var(--vz-font-mono)",
              }}
              {...props}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

// ─── Tool Renderers ──────────────────────────────────────────────────

function DownloadButton({ containerId, filePath }: { containerId: string | null; filePath: string }) {
  if (!containerId || !filePath) return null;
  const shortId = containerId.slice(0, 12);
  const url = `/preview/${shortId}/files${filePath.startsWith("/") ? filePath : `/${filePath}`}`;
  return (
    <a
      href={url}
      download
      className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
      title="Download file"
      onClick={(e) => e.stopPropagation()}
    >
      <Download className="w-3 h-3" />
    </a>
  );
}

type DiffLine = { type: "context" | "removed" | "added"; text: string; num?: number };
const CONTEXT_LINES = 3;

function buildUnifiedDiff(oldStr: string, newStr: string, fileContent?: string): DiffLine[] {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  let contextBefore: string[] = [];
  let contextAfter: string[] = [];
  let startLineNum = 1;

  if (fileContent && newStr) {
    const fileLines = fileContent.split("\n");
    const idx = fileContent.indexOf(newStr);
    if (idx !== -1) {
      const linesBefore = fileContent.slice(0, idx).split("\n");
      startLineNum = linesBefore.length;
      const endLineNum = startLineNum + newLines.length - 1;

      const grabBefore = Math.max(0, CONTEXT_LINES - prefix);
      if (grabBefore > 0) {
        const from = Math.max(0, startLineNum - 1 - grabBefore);
        contextBefore = fileLines.slice(from, startLineNum - 1);
      }

      const grabAfter = Math.max(0, CONTEXT_LINES - suffix);
      if (grabAfter > 0) {
        contextAfter = fileLines.slice(endLineNum, endLineNum + grabAfter);
      }
    }
  }

  const lines: DiffLine[] = [];
  let num = Math.max(1, startLineNum - contextBefore.length);

  for (const text of contextBefore) {
    lines.push({ type: "context", text, num: num++ });
  }
  for (let i = 0; i < prefix; i++) {
    lines.push({ type: "context", text: oldLines[i], num: num++ });
  }
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    lines.push({ type: "removed", text: oldLines[i] });
  }
  for (let i = prefix; i < newLines.length - suffix; i++) {
    lines.push({ type: "added", text: newLines[i], num: num++ });
  }
  for (let i = newLines.length - suffix; i < newLines.length; i++) {
    lines.push({ type: "context", text: newLines[i], num: num++ });
  }
  for (const text of contextAfter) {
    lines.push({ type: "context", text, num: num++ });
  }

  return lines;
}

function EditRenderer({ input, output, containerId }: { input?: Record<string, unknown>; output?: Record<string, unknown> | null; containerId: string | null }) {
  const filePath = (input?.file_path ?? output?.filePath ?? "") as string;
  const oldStr = (input?.old_string ?? output?.oldString ?? "") as string;
  const newStr = (input?.new_string ?? output?.newString ?? "") as string;
  const fileName = filePath.split("/").pop() ?? filePath;
  const [fileContent, setFileContent] = useState<string | undefined>();

  useEffect(() => {
    if (!containerId || !filePath) return;
    const shortId = containerId.slice(0, 12);
    const url = `/preview/${shortId}/files${filePath.startsWith("/") ? filePath : `/${filePath}`}`;
    fetch(url).then((r) => r.ok ? r.text() : null).then((text) => {
      if (text) setFileContent(text);
    }).catch(() => {});
  }, [containerId, filePath]);

  const diffLines = useMemo(() => buildUnifiedDiff(oldStr, newStr, fileContent), [oldStr, newStr, fileContent]);

  const removedBg = "color-mix(in srgb, var(--vz-fail) 12%, transparent)";
  const addedBg = "color-mix(in srgb, var(--vz-ok) 12%, transparent)";
  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ background: "var(--vz-mute)", borderBottom: "1px solid var(--vz-border)" }}
      >
        <FileText className="w-3 h-3" style={{ color: "var(--vz-info)" }} />
        <span className="font-mono" style={{ color: "var(--vz-ink)" }}>{fileName}</span>
        <span className="text-[10px] truncate" style={{ color: "var(--vz-muted-2)" }}>{filePath}</span>
        <DownloadButton containerId={containerId} filePath={filePath} />
      </div>
      <div className="font-mono overflow-x-auto max-h-60 overflow-y-auto">
        {diffLines.map((dl, i) => (
          <div
            key={i}
            className="flex"
            style={{
              background: dl.type === "removed" ? removedBg : dl.type === "added" ? addedBg : "transparent",
              color:
                dl.type === "removed" ? "var(--vz-fail)" :
                dl.type === "added" ? "var(--vz-ok)" :
                "var(--vz-ink-2)",
            }}
          >
            <span
              className="select-none text-right w-8 shrink-0 pr-1 py-0.5"
              style={{ color: "var(--vz-muted-2)", opacity: 0.7 }}
            >
              {dl.num ?? ""}
            </span>
            <span className="select-none w-4 text-center py-0.5">
              {dl.type === "removed" ? "-" : dl.type === "added" ? "+" : ""}
            </span>
            <span className="pl-1 py-0.5 whitespace-pre">{dl.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WriteRenderer({ output, containerId }: { output: Record<string, unknown>; containerId: string | null }) {
  const filePath = (output.filePath ?? "") as string;
  const content = (output.content ?? "") as string;
  const fileName = filePath.split("/").pop() ?? filePath;
  const isCreate = output.type === "create";

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ background: "var(--vz-mute)", borderBottom: "1px solid var(--vz-border)" }}
      >
        <FileText className="w-3 h-3" style={{ color: "var(--vz-ok)" }} />
        <span className="font-mono" style={{ color: "var(--vz-ink)" }}>{fileName}</span>
        <span
          className="text-[9px] font-medium"
          style={{
            padding: "1px 6px", borderRadius: 4,
            background: "color-mix(in srgb, var(--vz-ok) 14%, transparent)",
            color: "var(--vz-ok)",
            fontFamily: "var(--vz-font-mono)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {isCreate ? "created" : "updated"}
        </span>
        <span className="text-[10px] truncate" style={{ color: "var(--vz-muted-2)" }}>{filePath}</span>
        <DownloadButton containerId={containerId} filePath={filePath} />
      </div>
      <pre
        className="px-3 py-1.5 font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap"
        style={{ color: "var(--vz-ink-2)" }}
      >
        {content.length > 500 ? content.slice(0, 500) + `\n... (${content.length} chars total)` : content}
      </pre>
    </div>
  );
}

// ─── CSV Detection & Table View ──────────────────────────────────────

type ParsedTable = { headers: string[]; rows: string[][]; delimiter: string };

function parseCSV(text: string): ParsedTable | null {
  const lines = text.trim().replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  // Try delimiters in order of preference
  for (const delimiter of [",", "\t", "|"]) {
    const counts = lines.map((l) => {
      let count = 0;
      let inQuote = false;
      for (const ch of l) {
        if (ch === '"') inQuote = !inQuote;
        else if (ch === delimiter && !inQuote) count++;
      }
      return count;
    });
    const colCount = counts[0];
    if (colCount < 1) continue;
    // At least 80% of lines should have the same column count
    const matching = counts.filter((c) => c === colCount).length;
    if (matching / counts.length < 0.8) continue;

    const splitLine = (line: string): string[] => {
      const cols: string[] = [];
      let current = "";
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === delimiter && !inQuote) { cols.push(current.trim()); current = ""; continue; }
        current += ch;
      }
      cols.push(current.trim());
      return cols;
    };

    const headers = splitLine(lines[0]);
    const rows = lines.slice(1).map(splitLine);
    return { headers, rows, delimiter };
  }
  return null;
}

export function detectCSV(text: string): ParsedTable | null {
  if (!text || text.length > 50000) return null; // skip huge output
  return parseCSV(text);
}

const PAGE_SIZE_INLINE = 100;
const PAGE_SIZE_FULL = 50;

function TableHeader({ headers, sortCol, sortAsc, onSort, className }: {
  headers: string[];
  sortCol: number | null;
  sortAsc: boolean;
  onSort: (col: number) => void;
  className?: string;
}) {
  return (
    <thead className={`sticky top-0 bg-gray-50 z-10 ${className ?? ""}`}>
      <tr>
        {headers.map((h, i) => (
          <th
            key={i}
            onClick={() => onSort(i)}
            className="px-3 py-1.5 text-left text-gray-500 font-medium cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap border-b border-gray-200"
          >
            {h}
            {sortCol === i && <span className="ml-1 text-gray-400">{sortAsc ? "↑" : "↓"}</span>}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;

  // Build page numbers: show first, last, and ±2 around current
  const pages: (number | "...")[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 2 && i <= page + 2)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }

  return (
    <div className="flex items-center justify-center gap-1 py-2 border-t border-gray-100">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page === 1}
        className="px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 disabled:opacity-30 rounded cursor-pointer"
      >
        Prev
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} className="px-1 text-[10px] text-gray-400">...</span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={`px-2 py-0.5 text-[10px] rounded cursor-pointer transition-colors ${
              p === page ? "bg-blue-100 text-blue-700 font-medium" : "text-gray-500 hover:bg-gray-100"
            }`}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onPage(page + 1)}
        disabled={page === totalPages}
        className="px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 disabled:opacity-30 rounded cursor-pointer"
      >
        Next
      </button>
    </div>
  );
}

export function TableView({ table, title }: { table: ParsedTable; title?: string }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullPage, setFullPage] = useState(1);

  const sorted = useMemo(() => {
    if (sortCol === null) return table.rows;
    return [...table.rows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const an = Number(av), bn = Number(bv);
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv);
      return sortAsc ? cmp : -cmp;
    });
  }, [table.rows, sortCol, sortAsc]);

  const truncated = !showAll && sorted.length > PAGE_SIZE_INLINE;
  const visible = truncated ? sorted.slice(0, PAGE_SIZE_INLINE) : sorted;

  const fullTotalPages = Math.ceil(sorted.length / PAGE_SIZE_FULL);
  const fullVisible = sorted.slice((fullPage - 1) * PAGE_SIZE_FULL, fullPage * PAGE_SIZE_FULL);

  const handleSort = (col: number) => {
    if (sortCol === col) { setSortAsc(!sortAsc); }
    else { setSortCol(col); setSortAsc(true); }
    setFullPage(1);
  };

  const copyCSV = () => {
    const csv = [table.headers.join(","), ...table.rows.map((r) => r.join(","))].join("\n");
    navigator.clipboard.writeText(csv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadCSV = () => {
    const csv = [table.headers.join(","), ...table.rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title ?? "data"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const infoText = `${table.rows.length} row${table.rows.length !== 1 ? "s" : ""} · ${table.headers.length} col${table.headers.length !== 1 ? "s" : ""}`;

  const toolButtons = (iconSize = "w-3 h-3") => (
    <>
      <button onClick={copyCSV} className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer" title="Copy as CSV">
        {copied ? <Check className={`${iconSize} text-green-500`} /> : <Copy className={iconSize} />}
      </button>
      <button onClick={downloadCSV} className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer" title="Download CSV">
        <Download className={iconSize} />
      </button>
    </>
  );

  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 py-1 bg-gray-50 border-b border-gray-100">
        <span className="text-[10px] text-gray-400 mr-auto">{infoText}</span>
        {toolButtons()}
        <button onClick={() => setFullscreen(true)} className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer" title="Enlarge">
          <Maximize2 className="w-3 h-3" />
        </button>
      </div>
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full text-[11px] font-mono">
          <TableHeader headers={table.headers} sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
          <tbody>
            {visible.map((row, i) => (
              <tr key={i} className="border-t border-gray-100 hover:bg-blue-50/30">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1 text-gray-700 whitespace-nowrap">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full py-1.5 text-[10px] text-blue-500 hover:text-blue-700 hover:bg-blue-50 cursor-pointer transition-colors border-t border-gray-100"
        >
          Show all {table.rows.length} rows (showing first {PAGE_SIZE_INLINE})
        </button>
      )}

      {/* Fullscreen — paginated, sticky header, full tools */}
      {fullscreen && (
        <FullscreenOverlay
          title={title ?? "Table"}
          actions={<>
            <span className="text-xs text-gray-400 mr-2">{infoText}</span>
            {toolButtons("w-4 h-4")}
          </>}
          onClose={() => setFullscreen(false)}
        >
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm font-mono">
                <TableHeader headers={table.headers} sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                <tbody>
                  {fullVisible.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-blue-50/30">
                      {row.map((cell, j) => (
                        <td key={j} className="px-3 py-2 text-gray-700 whitespace-nowrap">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={fullPage} totalPages={fullTotalPages} onPage={setFullPage} />
          </div>
        </FullscreenOverlay>
      )}
    </div>
  );
}

/** Toggle bar for raw/table view, shown when CSV is detected */
function RawTableToggle({ view, onToggle }: { view: "raw" | "table"; onToggle: () => void }) {
  return (
    <div className="flex rounded-md border border-gray-200 overflow-hidden">
      <button
        onClick={view === "table" ? onToggle : undefined}
        className={`px-2 py-0.5 text-[10px] cursor-pointer transition-colors ${
          view === "raw" ? "bg-white text-gray-700 font-medium" : "bg-gray-100 text-gray-400 hover:text-gray-600"
        }`}
      >
        Raw
      </button>
      <button
        onClick={view === "raw" ? onToggle : undefined}
        className={`px-2 py-0.5 text-[10px] cursor-pointer transition-colors ${
          view === "table" ? "bg-white text-gray-700 font-medium" : "bg-gray-100 text-gray-400 hover:text-gray-600"
        }`}
      >
        Table
      </button>
    </div>
  );
}

// ─── Bash & Read Renderers ───────────────────────────────────────────

function BashRenderer({ input, output }: { input?: Record<string, unknown>; output: string }) {
  const command = (input?.command ?? "") as string;
  let stdout = "";
  let stderr = "";
  try {
    const parsed = JSON.parse(output);
    stdout = parsed.stdout ?? "";
    stderr = parsed.stderr ?? "";
  } catch {
    stdout = output;
  }

  // Truncate long commands (heredocs, multi-line scripts) to first line
  const displayCmd = useMemo(() => {
    const firstLine = command.split("\n")[0];
    return firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
  }, [command]);

  const table = useMemo(() => detectCSV(stdout), [stdout]);
  const [userView, setUserView] = useState<"raw" | "table" | null>(null);
  const view = userView ?? (table ? "table" : "raw");

  return (
    <div>
      {command && (
        <div
          className="px-3 py-1.5 font-mono overflow-x-auto"
          style={{ background: "var(--vz-graphite)", color: "var(--vz-ink-2)" }}
        >
          <span className="select-none" style={{ color: "var(--vz-sodium)" }}>$ </span>{displayCmd}
        </div>
      )}
      {table && (
        <div
          className="flex items-center px-3 py-1"
          style={{ background: "var(--vz-mute)", borderBottom: "1px solid var(--vz-border)" }}
        >
          <span
            className="mr-auto"
            style={{ fontFamily: "var(--vz-font-mono)", fontSize: 10, color: "var(--vz-muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            Output
          </span>
          <RawTableToggle view={view} onToggle={() => setUserView(view === "raw" ? "table" : "raw")} />
        </div>
      )}
      {stdout && (
        view === "table" && table ? (
          <TableView table={table} />
        ) : (
          <pre
            className="px-3 py-1.5 font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap"
            style={{ background: "var(--vz-mute)", color: "var(--vz-ink-2)" }}
          >
            {stdout.length > 500 ? stdout.slice(0, 500) + `\n... (${stdout.length} chars)` : stdout}
          </pre>
        )
      )}
      {stderr && (
        <pre
          className="px-3 py-1.5 font-mono overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap"
          style={{
            background: "color-mix(in srgb, var(--vz-fail) 10%, transparent)",
            color: "var(--vz-fail)",
          }}
        >
          {stderr}
        </pre>
      )}
    </div>
  );
}

function ReadRenderer({ input, output }: { input?: Record<string, unknown>; output?: string }) {
  const filePath = (input?.file_path ?? "") as string;
  const fileName = filePath.split("/").pop() ?? filePath;

  let content = output ?? "";
  try {
    const parsed = JSON.parse(content);
    if (parsed?.file?.content) {
      content = parsed.file.content;
    } else if (parsed?.content) {
      content = parsed.content;
    }
  } catch { /* use raw */ }

  const isCSVFile = /\.(csv|tsv)$/i.test(fileName);
  const table = useMemo(() => isCSVFile ? detectCSV(content) : null, [content, isCSVFile]);
  const [userView, setUserView] = useState<"raw" | "table" | null>(null);
  const view = userView ?? (table ? "table" : "raw");

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ background: "var(--vz-mute)", borderBottom: "1px solid var(--vz-border)" }}
      >
        <FileText className="w-3 h-3" style={{ color: "var(--vz-muted-2)" }} />
        <span className="font-mono" style={{ color: "var(--vz-ink)" }}>{fileName}</span>
        <span className="font-mono text-[10px] truncate" style={{ color: "var(--vz-muted-2)" }}>{filePath}</span>
        {table && <span className="ml-auto"><RawTableToggle view={view} onToggle={() => setUserView(view === "raw" ? "table" : "raw")} /></span>}
      </div>
      {content && (
        view === "table" && table ? (
          <TableView table={table} />
        ) : (
          <pre
            className="px-3 py-1.5 font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap"
            style={{ color: "var(--vz-ink-2)" }}
          >
            {content.length > 800 ? content.slice(0, 800) + `\n... (${content.length} chars)` : content}
          </pre>
        )
      )}
    </div>
  );
}

// ─── AskUserQuestion Renderer ────────────────────────────────────────

/** Parse AskUserQuestion input — handles both proper questions[] format and flat format from SDK */
export function parseAskUserInput(input?: Record<string, unknown>): Array<{ question: string; options: string[] }> {
  if (!input) return [];

  // Proper format: { questions: [{ question, options: [{ label }] }] }
  if (Array.isArray(input.questions)) {
    return (input.questions as Array<Record<string, unknown>>).map((q) => ({
      question: q.question as string,
      options: (q.options as Array<Record<string, unknown>>)?.map((o) => o.label as string) ?? [],
    }));
  }

  // Flat format from SDK in bypassPermissions: { question: "...", options: "[\"A\", \"B\"]" }
  if (input.question) {
    let opts: string[] = [];
    try {
      opts = typeof input.options === "string" ? JSON.parse(input.options as string) : (input.options as string[] ?? []);
    } catch { /* ignore */ }
    return [{ question: input.question as string, options: opts }];
  }

  return [];
}

/** Bottom-bar question picker — replaces the input area when agent asks a question */
export function QuestionPicker({
  question,
  options,
  onSelect,
  onSkip,
}: {
  question: string;
  options: string[];
  onSelect: (answer: string) => void;
  onSkip: () => void;
}) {
  const [customText, setCustomText] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((prev) => Math.max(0, prev - 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((prev) => Math.min(options.length, prev + 1)); // +1 for "Something else"
    } else if (e.key === "Enter" && !customText) {
      e.preventDefault();
      if (focusIdx < options.length) {
        onSelect(options[focusIdx]);
      }
    } else if (e.key === "Enter" && customText) {
      e.preventDefault();
      onSelect(customText);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSkip();
    }
  };

  const isFocused = (idx: number) => focusIdx === idx;
  const sodiumTint = "color-mix(in srgb, var(--vz-sodium) 10%, transparent)";

  return (
    <div className="px-4 pb-4 pt-2" onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="max-w-3xl mx-auto">
        <div
          className="rounded-xl overflow-hidden"
          style={{
            background: "var(--vz-card)",
            border: "1px solid var(--vz-border)",
            boxShadow: "var(--vz-shadow-md)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-2.5"
            style={{ borderBottom: "1px solid var(--vz-border)" }}
          >
            <p className="text-sm font-medium" style={{ color: "var(--vz-ink)" }}>
              {question}
            </p>
            <button
              onClick={onSkip}
              className="px-2 py-0.5 rounded cursor-pointer transition-colors"
              style={{
                fontSize: 10,
                fontFamily: "var(--vz-font-mono)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--vz-muted-2)",
                border: "1px solid var(--vz-border)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--vz-ink-2)";
                (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--vz-muted-2)";
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              Skip
            </button>
          </div>
          <div className="py-1">
            {options.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => onSelect(label)}
                onMouseEnter={() => setFocusIdx(idx)}
                className="w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors cursor-pointer"
                style={{
                  background: isFocused(idx) ? sodiumTint : "transparent",
                  color: isFocused(idx) ? "var(--vz-sodium)" : "var(--vz-ink-2)",
                  fontWeight: isFocused(idx) ? 500 : 400,
                }}
              >
                <span
                  className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--vz-font-mono)",
                    fontWeight: 600,
                    background: isFocused(idx)
                      ? "color-mix(in srgb, var(--vz-sodium) 18%, transparent)"
                      : "var(--vz-mute)",
                    color: isFocused(idx) ? "var(--vz-sodium)" : "var(--vz-muted-2)",
                  }}
                >
                  {idx + 1}
                </span>
                <span>{label}</span>
                {isFocused(idx) && (
                  <span
                    className="ml-auto"
                    style={{
                      fontSize: 10,
                      fontFamily: "var(--vz-font-mono)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--vz-muted-2)",
                    }}
                  >
                    Enter
                  </span>
                )}
              </button>
            ))}
            {/* Free text option */}
            <div
              className="flex items-center gap-3 px-4 py-2"
              style={{ borderTop: "1px solid var(--vz-border)" }}
            >
              <span
                className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                style={{
                  background: "var(--vz-mute)",
                  color: "var(--vz-muted-2)",
                }}
              >
                <FileText className="w-2.5 h-2.5" />
              </span>
              <input
                type="text"
                placeholder="Something else..."
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onFocus={() => setFocusIdx(options.length)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customText.trim()) {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(customText.trim());
                  }
                }}
                className="vz-question-input flex-1 text-sm bg-transparent border-none focus:outline-none"
                style={{ color: "var(--vz-ink-2)" }}
              />
            </div>
          </div>
        </div>
        <p
          className="text-center mt-1.5"
          style={{
            fontSize: 10,
            fontFamily: "var(--vz-font-mono)",
            letterSpacing: "0.06em",
            color: "var(--vz-muted-2)",
          }}
        >
          Click to select · Esc to skip
        </p>
      </div>
    </div>
  );
}

function DefaultRenderer({ input, output }: { input?: Record<string, unknown>; output?: string }) {
  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--vz-font-mono)",
    fontSize: 10,
    color: "var(--vz-muted-2)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "6px 12px 0",
  };
  const preStyle: React.CSSProperties = {
    color: "var(--vz-ink-2)",
  };
  return (
    <>
      {input && Object.keys(input).length > 0 && (
        <div style={{ borderBottom: "1px solid var(--vz-border)" }}>
          <div style={labelStyle}>Input</div>
          <pre className="font-mono px-3 py-1.5 overflow-x-auto max-h-32 overflow-y-auto" style={preStyle}>
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {output && (
        <div>
          <div style={labelStyle}>Output</div>
          <pre className="font-mono px-3 py-1.5 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap" style={preStyle}>
            {output.length > 1000 ? output.slice(0, 1000) + `\n... (${output.length} chars)` : output}
          </pre>
        </div>
      )}
    </>
  );
}

// ─── Tool Renderer Registry ───────────────────────────────────────────

export interface ToolRendererProps {
  input?: Record<string, unknown>;
  output?: string;
  containerId: string | null;
}

interface ToolRendererConfig {
  /** Component to render the expanded tool block */
  component: React.ComponentType<ToolRendererProps>;
  /** Short summary for collapsed view (e.g. filename for Edit) */
  summary?: (input: Record<string, unknown>) => string | null;
  /** Hide this tool entirely from the message list */
  hidden?: boolean;
  /** Auto-expand on render. Function form receives input+output for dynamic decisions. */
  autoExpand?: boolean | ((input?: Record<string, unknown>, output?: string) => boolean);
}

/** Wraps typed renderers so they conform to the generic ToolRendererProps interface */
function editAdapter(props: ToolRendererProps) {
  let parsedOutput: Record<string, unknown> | null = null;
  if (props.output) {
    try { parsedOutput = JSON.parse(props.output); } catch { /* raw text */ }
  }
  return <EditRenderer input={props.input} output={parsedOutput} containerId={props.containerId} />;
}

function writeAdapter(props: ToolRendererProps) {
  let parsedOutput: Record<string, unknown> | null = null;
  if (props.output) {
    try { parsedOutput = JSON.parse(props.output); } catch { /* raw text */ }
  }
  if (!parsedOutput) return <DefaultRenderer input={props.input} output={props.output} />;
  return <WriteRenderer output={parsedOutput} containerId={props.containerId} />;
}

function bashAdapter(props: ToolRendererProps) {
  return <BashRenderer input={props.input} output={props.output ?? ""} />;
}

function readAdapter(props: ToolRendererProps) {
  return <ReadRenderer input={props.input} output={props.output} />;
}

function defaultAdapter(props: ToolRendererProps) {
  return <DefaultRenderer input={props.input} output={props.output} />;
}

function mermaidAdapter({ input, output }: ToolRendererProps) {
  const code = (input?.code as string) ?? output ?? "";
  return <MermaidBlock code={code} />;
}

function csvTableAdapter({ input, output }: ToolRendererProps) {
  const text = (input?.data as string) ?? output ?? "";
  const table = parseCSV(text);
  if (!table) return <DefaultRenderer input={input} output={output} />;
  return <TableView table={table} />;
}

const TOOL_RENDERERS: Record<string, ToolRendererConfig> = {
  Edit: {
    component: editAdapter,
    summary: (input) => (input?.file_path as string)?.split("/").pop() ?? null,
    autoExpand: true,
  },
  Write: {
    component: writeAdapter,
    summary: (input) => (input?.file_path as string)?.split("/").pop() ?? null,
  },
  Bash: {
    component: bashAdapter,
    summary: (input) => {
      const cmd = input?.command as string;
      if (!cmd) return null;
      const firstLine = cmd.split("\n")[0];
      return firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
    },
  },
  Read: {
    component: readAdapter,
    summary: (input) => (input?.file_path as string)?.split("/").pop() ?? null,
  },
  Glob: {
    component: defaultAdapter,
    summary: (input) => (input?.pattern as string) ?? null,
  },
  Grep: {
    component: defaultAdapter,
    summary: (input) => input?.pattern ? `/${input.pattern}/` : null,
  },
  Mermaid: {
    component: mermaidAdapter,
    summary: (input) => (input?.title as string) ?? "diagram",
    autoExpand: true,
  },
  CSVTable: {
    component: csvTableAdapter,
    summary: (input) => (input?.title as string) ?? "table",
    autoExpand: true,
  },
  TodoWrite: { component: defaultAdapter, hidden: true },
  AskUserQuestion: { component: defaultAdapter, hidden: true },
};

/** Register a custom tool renderer (for extensions / plugins) */
export function registerToolRenderer(tool: string, config: ToolRendererConfig) {
  TOOL_RENDERERS[tool] = config;
}

// ─── ToolBlock ────────────────────────────────────────────────────────

// Icon for the header bar — falls back to Wrench for unmapped tools.
function toolIcon(tool: string): React.ComponentType<{ size?: number; className?: string }> {
  switch (tool) {
    case "Bash": return Terminal;
    case "Read": return FileText;
    case "Write": return FilePlus;
    case "Edit": return FileEdit;
    case "Grep": return Search;
    case "Glob": return FolderSearch;
    case "Mermaid": return GitBranch;
    case "WebFetch":
    case "WebSearch": return Eye;
    default: return Wrench;
  }
}

export function ToolBlock({ tool, input, output, pending, containerId }: {
  tool: string;
  input?: Record<string, unknown>;
  output?: string;
  pending?: boolean;
  containerId: string | null;
}) {
  const config = TOOL_RENDERERS[tool];
  if (config?.hidden) return null;

  const shouldAutoExpand = typeof config?.autoExpand === "function"
    ? config.autoExpand(input, output)
    : config?.autoExpand ?? false;
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? shouldAutoExpand;
  const hasDetails = (input && Object.keys(input).length > 0) || !!output;
  const summary = useMemo(() => config?.summary?.(input ?? {}) ?? null, [tool, input]);
  const Renderer = config?.component ?? defaultAdapter;
  const Icon = toolIcon(tool);

  // Status pill — RUNNING (sodium) while pending, OK (green) once output lands,
  // empty when there's nothing to report yet.
  const statusPill = pending ? (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--vz-sodium)",
        background: "var(--vz-sodium-08)",
        border: "1px solid var(--vz-sodium-25)",
        padding: "2px 8px",
        borderRadius: 5,
      }}
    >
      <Loader2 className="w-2.5 h-2.5 animate-spin" />
      Running
    </span>
  ) : output ? (
    <span
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--vz-ok)",
        background: "color-mix(in srgb, var(--vz-ok) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--vz-ok) 35%, transparent)",
        padding: "2px 8px",
        borderRadius: 5,
      }}
    >
      OK
    </span>
  ) : null;

  return (
    <div className="my-1.5">
      <div
        style={{
          background: "var(--vz-card)",
          border: "1px solid var(--vz-border)",
          borderRadius: "var(--vz-radius-md)",
          overflow: "hidden",
        }}
      >
        {/* Header — click to expand/collapse */}
        <button
          type="button"
          onClick={() => hasDetails && setUserExpanded(!expanded)}
          disabled={!hasDetails}
          className="w-full flex items-center gap-2.5"
          style={{
            padding: "8px 12px",
            background: "transparent",
            border: 0,
            cursor: hasDetails ? "pointer" : "default",
            textAlign: "left",
            transition: "background var(--vz-fast) var(--vz-ease)",
          }}
          onMouseEnter={(e) => {
            if (hasDetails) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          {hasDetails && (
            expanded
              ? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
              : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
          )}
          <Icon size={14} className="shrink-0" />
          <span
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--vz-ink)",
              letterSpacing: "-0.005em",
            }}
          >
            {tool}
          </span>
          {summary && (
            <span
              className="truncate"
              style={{
                fontFamily: "var(--vz-font-mono)",
                fontSize: 12,
                color: "var(--vz-muted)",
                flex: 1,
                minWidth: 0,
              }}
            >
              {summary}
            </span>
          )}
          {statusPill && <span className={summary ? "shrink-0" : "ml-auto shrink-0"}>{statusPill}</span>}
        </button>

        {/* Body */}
        {expanded && hasDetails && (
          <div
            style={{
              borderTop: "1px solid var(--vz-border)",
              fontSize: 11,
            }}
          >
            <Renderer input={input} output={output} containerId={containerId} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EventLogPanel (Playground-only, but exported for convenience) ───

export function EventLogPanel({
  events,
  onClear,
  scrollRef,
}: {
  events: Array<{ time: string; data: Record<string, unknown> }>;
  onClear: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = events.map((e) => `${e.time} ${e.data.type}\n${JSON.stringify(e.data, null, 2)}`).join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const typeColor = (type: unknown) => {
    switch (type) {
      case "system_prompt": return "text-cyan-600";
      case "token": return "text-blue-500";
      case "tool_use": return "text-amber-600";
      case "tool_result": return "text-green-600";
      case "error": return "text-red-500";
      case "done": case "turn.done": return "text-purple-600";
      default: return "text-gray-500";
    }
  };

  return (
    <div className="w-80 shrink-0 flex flex-col bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50">
        <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Event Log</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer"
            title="Copy all events"
          >
            {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          </button>
          <button
            onClick={onClear}
            className="p-1 text-gray-400 hover:text-gray-600 cursor-pointer"
            title="Clear log"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[10px] leading-relaxed">
        {events.map((evt, i) => (
          <div key={i} className="mb-1.5 pb-1.5 border-b border-gray-100">
            <span className="text-gray-400">{evt.time}</span>{" "}
            <span className={`font-medium ${typeColor(evt.data.type)}`}>{evt.data.type as string}</span>
            <pre className="text-gray-500 whitespace-pre-wrap break-all mt-0.5">
              {JSON.stringify(evt.data, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

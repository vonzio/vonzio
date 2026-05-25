import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import type { Highlighter } from "shiki";
import { useTheme } from "../hooks/useTheme.js";

// Languages we ship with the lazy highlighter. Anything else falls back to plain text.
const SHIKI_LANGS = [
  "typescript", "tsx", "javascript", "jsx",
  "json", "yaml", "toml",
  "html", "css", "scss",
  "bash", "shell",
  "python", "go", "rust", "java", "c", "cpp", "csharp", "ruby", "php",
  "sql", "markdown", "diff", "dockerfile", "ini",
];
const SHIKI_THEME_DARK = "one-dark-pro";
const SHIKI_THEME_LIGHT = "github-light";

let _hl: Highlighter | null = null;
let _hlPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (_hl) return _hl;
  if (_hlPromise) return _hlPromise;
  _hlPromise = (async () => {
    const { createHighlighter } = await import("shiki");
    const hl = await createHighlighter({
      themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
      langs: SHIKI_LANGS,
    });
    _hl = hl;
    return hl;
  })();
  return _hlPromise;
}

// Kick the highlighter import as soon as this module loads, so by the time
// the first <CodeBlock> actually mounts the singleton has a head start. No
// await — fire-and-forget; trySyncHighlight gates on _hl being populated.
if (typeof window !== "undefined") {
  getHighlighter().catch(() => {});
}

/** Synchronously highlight if the singleton is already loaded; null otherwise.
    This lets every CodeBlock after the first render highlighted on first frame
    so there's no flash from raw → colored. */
function trySyncHighlight(code: string, lang: string, theme: string): string | null {
  if (!_hl) return null;
  const loaded = _hl.getLoadedLanguages();
  const safeLang = loaded.includes(lang) ? lang : "text";
  try { return _hl.codeToHtml(code, { lang: safeLang, theme }); }
  catch { return null; }
}

// Resolve aliases the markdown ecosystem commonly emits.
function normalizeLang(raw?: string): string {
  if (!raw) return "text";
  const lang = raw.trim().toLowerCase();
  switch (lang) {
    case "ts": return "typescript";
    case "js": return "javascript";
    case "py": return "python";
    case "rs": return "rust";
    case "sh": return "bash";
    case "shell": return "bash";
    case "yml": return "yaml";
    case "md": return "markdown";
    default: return lang;
  }
}

export function langFromFilename(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    html: "html", htm: "html", css: "css", scss: "scss",
    sh: "bash", bash: "bash", zsh: "bash",
    py: "python", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
    rb: "ruby", php: "php",
    sql: "sql", md: "markdown", diff: "diff",
    dockerfile: "dockerfile", ini: "ini",
  };
  return map[ext] ?? "text";
}

interface Props {
  code: string;
  lang?: string;
  showLineNumbers?: boolean;
  /** Optional title shown in the header (e.g., file name). */
  title?: string;
}

/** Syntax-highlighted code block with optional line numbers. */
export function CodeBlock({ code, lang, showLineNumbers = true, title }: Props) {
  const normalized = normalizeLang(lang);
  const { surface } = useTheme();
  const theme = surface === "paper" ? SHIKI_THEME_LIGHT : SHIKI_THEME_DARK;
  // Synchronous initial render: if the highlighter singleton is already
  // warmed up, we render highlighted HTML on the first frame — no flash.
  const [html, setHtml] = useState<string | null>(() => trySyncHighlight(code, normalized, theme));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Already highlighted synchronously via initialState? Nothing to do.
    const sync = trySyncHighlight(code, normalized, theme);
    if (sync !== null) {
      setHtml(sync);
      return;
    }
    // Otherwise wait for the lazy loader.
    let cancelled = false;
    getHighlighter().then((hl) => {
      if (cancelled) return;
      const loaded = hl.getLoadedLanguages();
      const safeLang = loaded.includes(normalized) ? normalized : "text";
      try {
        const out = hl.codeToHtml(code, { lang: safeLang, theme });
        setHtml(out);
      } catch {
        setHtml(null);
      }
    }).catch(() => { if (!cancelled) setHtml(null); });
    return () => { cancelled = true; };
  }, [code, normalized, theme]);

  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      className="vz-codeblock"
      data-lined={showLineNumbers ? "true" : undefined}
      style={{
        position: "relative",
        border: "1px solid var(--vz-border)",
        borderRadius: "var(--vz-radius-md)",
        overflow: "hidden",
        margin: "8px 0",
      }}
    >
      {(title || normalized !== "text") && (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            background: "var(--vz-mute)",
            borderBottom: "1px solid var(--vz-border)",
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            color: "var(--vz-muted)",
            letterSpacing: "0.04em",
          }}
        >
          {title && <span style={{ color: "var(--vz-ink-2)" }}>{title}</span>}
          {normalized !== "text" && (
            <span style={{ color: "var(--vz-muted-2)", textTransform: "uppercase", fontSize: 10 }}>
              {normalized}
            </span>
          )}
          <button
            type="button"
            onClick={copy}
            className="ml-auto vz-action-btn"
            style={{ width: 22, height: 22 }}
            title={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check className="w-3 h-3" style={{ color: "var(--vz-ok)" }} /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      )}
      {html ? (
        <div
          className="vz-shiki"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        // Fallback uses the same .vz-shiki / <span class="line"> structure
        // as the highlighted output so the swap doesn't shift layout — only
        // the text colors change.
        <div className="vz-shiki">
          <pre>
            <code>
              {code.split("\n").map((line, i) => (
                <span key={i} className="line">{line || "​"}</span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}

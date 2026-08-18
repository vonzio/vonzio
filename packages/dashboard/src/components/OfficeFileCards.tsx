import { Download, FileText, Presentation, Table } from "lucide-react";

/**
 * Deliverable-file cards under assistant messages (issue #367).
 *
 * Office documents are created by skill scripts through Bash, so unlike
 * Write/Edit there is no tool payload naming the file — the reliable signal
 * is the agent stating the path in its reply (the office skills' output
 * convention). We scan the message text for /workspace paths with document
 * extensions and render a download card per file. Renders in the dashboard
 * chat and the embedded widget alike (both use MessageList); the /preview
 * download route is same-origin in both.
 */

const OFFICE_EXT = "docx|xlsx|pptx|pdf|xlsm|pptm|dotx|potx|xltx";
// Two shapes the agent states a deliverable in: a /workspace path, or a link
// to its own preview/fileserver URL (models often prefer a clickable link —
// that's the markdown target, so match URLs too).
const OFFICE_PATH_REGEX = new RegExp(`\\/workspace\\/[^\\s"'\`(){}\\[\\]<>|]+\\.(?:${OFFICE_EXT})\\b`, "gi");
const OFFICE_URL_REGEX = new RegExp(`https?:\\/\\/[^\\s"'\`(){}\\[\\]<>|]+\\.(?:${OFFICE_EXT})\\b(?:\\?[^\\s"'\`(){}\\[\\]<>|]*)?`, "gi");

export interface OfficeFileRef {
  /** Display name (basename). */
  name: string;
  /** Either a /workspace/... path (needs the container download route) or a
   *  ready-to-use URL the agent linked itself. */
  target: string;
  kind: "path" | "url";
}

/** Distinct office documents mentioned in `text`, in order. */
export function extractOfficeFiles(text: string): OfficeFileRef[] {
  if (!text) return [];
  const out: OfficeFileRef[] = [];
  const seenTargets = new Set<string>();
  const pathBasenames = new Set<string>();
  const push = (target: string, kind: "path" | "url") => {
    const pathname = kind === "url" ? target.split("?")[0] : target;
    // The fileserver refuses dot-segments; don't render cards that 404.
    if (pathname.split("/").some((seg) => seg.startsWith(".") && seg !== "")) return;
    if (seenTargets.has(pathname)) return;
    const name = pathname.slice(pathname.lastIndexOf("/") + 1);
    // Agents often state a file BOTH ways — "/workspace/deck.pptx ([download](…/deck.pptx))".
    // Suppress the URL alias of an already-carded path; distinct files that
    // merely share a basename (different dirs/targets) each keep their card.
    if (kind === "url" && pathBasenames.has(name)) return;
    if (kind === "path") pathBasenames.add(name);
    seenTargets.add(pathname);
    out.push({ name, target, kind });
  };
  for (const m of text.matchAll(OFFICE_PATH_REGEX)) push(m[0].replace(/[.,;:!?]+$/, ""), "path");
  for (const m of text.matchAll(OFFICE_URL_REGEX)) push(m[0], "url");
  return out;
}

function iconFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext.startsWith("xl")) return Table;
  if (ext.startsWith("p")) return ext === "pdf" ? FileText : Presentation;
  return FileText;
}

export function OfficeFileCards({ text, containerId }: { text: string; containerId: string | null }) {
  const files = extractOfficeFiles(text);
  if (files.length === 0) return null;
  const shortId = containerId?.slice(0, 12);
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {files.map(({ name, target, kind }) => {
        // Workspace paths need the container download route; agent-linked
        // URLs are usable as-is (and don't need a containerId at all).
        const href = kind === "url" ? target : shortId ? `/preview/${shortId}/files${target}` : null;
        if (!href) return null;
        const Icon = iconFor(name);
        return (
          <a
            key={target}
            href={href}
            download={name}
            className="inline-flex items-center gap-2 no-underline"
            style={{
              border: "1px solid var(--vz-border)", borderLeft: "3px solid var(--vz-sodium)",
              borderRadius: "var(--vz-radius-sm)", background: "var(--vz-mute)",
              padding: "8px 12px", color: "var(--vz-ink-2)", fontSize: 12.5,
            }}
            title={`Download ${name}`}
          >
            <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--vz-sodium)" }} />
            <span className="font-medium truncate" style={{ maxWidth: 220 }}>{name}</span>
            <Download className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
          </a>
        );
      })}
    </div>
  );
}

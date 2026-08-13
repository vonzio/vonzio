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

const OFFICE_FILE_REGEX = /\/workspace\/[^\s"'`(){}\[\]<>|]+\.(docx|xlsx|pptx|pdf|xlsm|pptm|dotx|potx|xltx)\b/gi;

/** Distinct /workspace document paths mentioned in `text`, in order. */
export function extractOfficeFiles(text: string): string[] {
  if (!text || !text.includes("/workspace/")) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(OFFICE_FILE_REGEX)) {
    // Strip trailing punctuation a sentence can pin onto the path.
    const path = match[0].replace(/[.,;:!?]+$/, "");
    // The fileserver refuses dot-segments; don't render cards that 404.
    if (path.split("/").some((seg) => seg.startsWith(".") && seg !== "")) continue;
    seen.add(path);
  }
  return [...seen];
}

function iconFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext.startsWith("xl")) return Table;
  if (ext.startsWith("p")) return ext === "pdf" ? FileText : Presentation;
  return FileText;
}

export function OfficeFileCards({ text, containerId }: { text: string; containerId: string | null }) {
  if (!containerId) return null;
  const files = extractOfficeFiles(text);
  if (files.length === 0) return null;
  const shortId = containerId.slice(0, 12);
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {files.map((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        const Icon = iconFor(path);
        return (
          <a
            key={path}
            href={`/preview/${shortId}/files${path}`}
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

import React, { useState, useEffect, useMemo } from "react";
import { Image, FileText, Loader2, Target, Check, Copy, BookOpen } from "lucide-react";
import { type ChatMessage, ToolBlock, MarkdownContent, detectCSV, TableView, extractCitations } from "./ChatCore.js";
import { ResponseFeedback } from "./ResponseFeedback.js";
import { DocViewerModal, type DocViewerTarget } from "./DocViewerModal.js";
import {
  fetchProfileDocuments, fetchWorkspaceDocuments,
  profileDocumentRawUrl, workspaceDocumentRawUrl,
} from "../api/client.js";
import { useOptionalUser } from "../contexts/UserContext.js";
import { useTheme } from "../hooks/useTheme.js";

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Match how the orchestrator names files under /knowledge, so /knowledge refs
 *  and model-cited filenames resolve back to the stored document. */
function sanitizeDocName(n: string): string {
  return n.replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
}

function initialOf(name?: string): string {
  if (!name) return "U";
  const first = name.trim()[0];
  return (first ?? "U").toUpperCase();
}

// Avatar column width (28px) + gap (12px) — content rows below the header
// indent to this width so they line up under the name, like the template.
const ROW_INDENT = 40;

function MsgRow({
  avatar,
  name,
  time,
  children,
  trailing,
  divider = false,
  compact = false,
}: {
  avatar: React.ReactNode;
  name: React.ReactNode;
  time: Date;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  divider?: boolean;
  // When true, suppress the avatar/name/time header row and render the
  // body directly — useful for stacking content rows under a single
  // shared header (e.g. multiple agent events in one turn).
  compact?: boolean;
}) {
  return (
    <div
      className="group/msg animate-[fadeIn_0.2s_ease-out]"
      style={{
        padding: compact ? "0 0 14px 0" : "14px 0",
        borderBottom: divider ? "1px solid var(--vz-border)" : "0",
      }}
    >
      {!compact && (
        <div className="flex items-center gap-3">
          <div className="shrink-0">{avatar}</div>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vz-ink)", lineHeight: 1 }}>
            {name}
          </span>
          <span
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11,
              color: "var(--vz-muted-2)",
              letterSpacing: "0.03em",
              lineHeight: 1,
            }}
          >
            {formatClockTime(time)}
          </span>
          {trailing && <span className="ml-auto">{trailing}</span>}
        </div>
      )}
      {/* Body indents under the header so it aligns with the name. */}
      <div style={{ marginTop: compact ? 0 : 8, paddingLeft: ROW_INDENT, color: "var(--vz-ink-2)" }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Renders just the agent avatar/name/time header — same look as the header
 * inside MsgRow. Used at the start of an agent turn that begins with a
 * tool call (so the tool card visually sits *under* the agent's identity
 * instead of orphaned next to the page margin).
 */
function AgentHeaderStrip({ time, copyText }: { time: Date; copyText?: string }) {
  return (
    <div
      className="group/msg animate-[fadeIn_0.2s_ease-out]"
      style={{ padding: "14px 0 8px 0" }}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0"><AgentAvatar /></div>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vz-ink)", lineHeight: 1 }}>
          vonzio<span style={{ color: "var(--vz-muted-2)", fontWeight: 400 }}> · agent</span>
        </span>
        <span
          style={{
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            color: "var(--vz-muted-2)",
            letterSpacing: "0.03em",
            lineHeight: 1,
          }}
        >
          {formatClockTime(time)}
        </span>
        {copyText && (
          <span className="ml-auto opacity-0 group-hover/msg:opacity-100 transition-opacity">
            <CopyMsgButton text={copyText} />
          </span>
        )}
      </div>
    </div>
  );
}

/** Small hover copy-to-clipboard button for a single message's text. */
function CopyMsgButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy message"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable — no-op */ }
      }}
      style={{
        display: "inline-grid", placeItems: "center",
        width: 22, height: 22, borderRadius: 5,
        background: "transparent", border: "none",
        color: copied ? "var(--vz-ok)" : "var(--vz-muted-2)",
        cursor: "pointer",
      }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function UserAvatar({ letter }: { letter: string }) {
  return (
    <div
      style={{
        width: 28, height: 28, borderRadius: 7,
        display: "grid", placeItems: "center",
        background: "var(--vz-mute)",
        border: "1px solid var(--vz-border)",
        color: "var(--vz-ink-3)",
        fontSize: 12, fontWeight: 600,
        fontFamily: "var(--vz-font-sans)",
      }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

function AgentAvatar() {
  return (
    <div
      style={{
        width: 28, height: 28, borderRadius: 7,
        display: "grid", placeItems: "center",
        background: "var(--vz-sodium-08)",
        border: "1px solid var(--vz-sodium-25)",
        color: "var(--vz-sodium)",
        fontSize: 13, fontWeight: 700,
        fontFamily: "var(--vz-font-mono)",
        letterSpacing: "-0.02em",
      }}
      aria-hidden="true"
    >
      v
    </div>
  );
}

/** Fetches a CSV file from the container and renders as a table */
function RemoteCSVTable({ containerId, filePath, title }: { containerId: string; filePath: string; title?: string }) {
  const [table, setTable] = useState<ReturnType<typeof detectCSV>>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const shortId = containerId.slice(0, 12);
    const url = `/preview/${shortId}/files${filePath.startsWith("/") ? filePath : `/${filePath}`}`;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); })
      .then((text) => {
        const parsed = detectCSV(text);
        if (parsed) setTable(parsed);
        else setError("File is not valid CSV");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [containerId, filePath]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-4 rounded-lg"
        style={{ color: "var(--vz-muted-2)", border: "1px solid var(--vz-border)" }}
      >
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-xs">Loading table...</span>
      </div>
    );
  }
  if (error || !table) return null;
  return (
    <div
      className="rounded-lg overflow-hidden text-[11px]"
      style={{ border: "1px solid var(--vz-border)" }}
    >
      <TableView table={table} title={title} />
    </div>
  );
}

/** Extract a .csv file path from a Bash command, Write tool, or tool output */
function extractCSVFilePath(msg: ChatMessage, toolInput?: Record<string, unknown>): string | null {
  // Write tool: check file_path directly
  if (msg.tool === "Write" && toolInput?.file_path) {
    const fp = toolInput.file_path as string;
    if (/\.csv$/i.test(fp)) return fp;
  }

  // Bash tool: find any /workspace/output/*.csv path in the command (covers shell redirection, Python open(), etc.)
  if (msg.tool === "Bash" && toolInput?.command) {
    const cmd = toolInput.command as string;
    const match = cmd.match(/(\/workspace\/www\/[^\s"',;|&)]+\.csv)/i);
    if (match) return match[1];
  }

  // Check tool output for file paths
  try {
    const parsed = JSON.parse(msg.content);
    const stdout = (parsed?.stdout ?? "") as string;
    const match = stdout.match(/(\/workspace\/www\/[^\s"',;|&)]+\.csv)/i);
    if (match) return match[1];
  } catch { /* ignore */ }

  return null;
}

export function MessageList({
  messages,
  showTools,
  streaming,
  containerId,
  profileId,
  sessionId,
}: {
  messages: ChatMessage[];
  showTools: boolean;
  streaming: boolean;
  containerId: string | null;
  profileId?: string;
  /** Workspace session id — lets Source chips resolve to a doc + open it. */
  sessionId?: string | null;
}) {
  const [sourceViewer, setSourceViewer] = useState<DocViewerTarget | null>(null);
  // Re-render every 30s so relative timestamps update
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // MessageList renders in two contexts: the authenticated dashboard
  // (UserContext.Provider wraps everything) AND the public /chat embed
  // route (no provider, no session). Fall back to a generic "U" when
  // the user is anonymous; the embed has no identity to display anyway.
  const user = useOptionalUser();
  const userInitial = initialOf(user?.name || user?.email);
  const { surface } = useTheme();
  const proseClass = surface === "paper" ? "prose" : "prose prose-invert";

  // Render messages in ARRIVAL order — no per-turn reordering.
  //
  // A previous version partitioned each turn into [tools, texts, system],
  // forcing every tool call above every text bubble. That was a workaround
  // for a streaming bug (post-tool tokens overwrote the pre-tool bubble in
  // place — fixed in useWorkspaceChat: each tool boundary now ends the
  // streaming segment) and it actively broke faithful rendering: the model's
  // plan text ("I'll build…") emitted BEFORE its first tool call rendered
  // below it, and interleaved text→tool→text narration was flattened into
  // [all tools][all texts]. The event log (per-session JSONL) is the ordering
  // source of truth and both the live relay and replay deliver it in order —
  // so arrival order IS chronological order. Don't reorder here.
  const orderedMessages = messages;

  const turnStarters = useMemo(() => {
    const starters = new Map<string, Date>();
    let pendingStart = true;
    for (let i = 0; i < orderedMessages.length; i++) {
      const msg = orderedMessages[i];
      if (msg.role === "user") {
        pendingStart = true;
        continue;
      }
      // Mirror the dedup that the render does: a tool_use immediately
      // followed by its matching tool_result is hidden, so it can't be
      // the turn starter. Look ahead in the ORIGINAL array (dedup uses
      // chronological neighbors, not the reordered view).
      if (msg.role === "tool_use") {
        const origIdx = messages.indexOf(msg);
        let willHide = false;
        if (origIdx >= 0) {
          for (let j = origIdx + 1; j < messages.length && j <= origIdx + 5; j++) {
            if (messages[j].role === "tool_result" && messages[j].tool === msg.tool) { willHide = true; break; }
            if (messages[j].role === "tool_use" && messages[j].tool === msg.tool) break;
          }
          if (!willHide && origIdx > 0 && messages[origIdx - 1].role === "tool_use" && messages[origIdx - 1].tool === msg.tool) {
            willHide = true;
          }
        }
        if (willHide) continue;
      }
      if (pendingStart) {
        starters.set(msg.id, msg.timestamp);
        pendingStart = false;
      }
    }
    return starters;
  }, [messages, orderedMessages]);

  // Per-turn knowledge "Sources": derived from the agent's actual Read calls on
  // /knowledge files within the turn (ground truth — not the model self-citing,
  // which can hallucinate). Keyed by the turn's LAST assistant message id, so a
  // "Sources: …" footer renders under the answer. INDEX.md (the manifest) is
  // excluded — reading it isn't using a source.
  const turnSources = useMemo(() => {
    const map = new Map<string, Array<{ name: string; pages: number[] }>>();
    let start = 0;
    // Match any /knowledge/<file> reference in a tool's input. Covers Read
    // (file_path), Bash (`pdftotext /knowledge/x.pdf -` — how non-Anthropic
    // models read PDFs), and Grep (path). INDEX.md is the manifest, not a source.
    const KNOWLEDGE_REF = /\/knowledge\/([A-Za-z0-9._-]+)/g;
    const flush = (end: number) => {
      let lastAssistant: string | null = null;
      const byFile = new Map<string, Set<number>>(); // name → page numbers
      const note = (name: string | undefined, pages: number[] = []) => {
        if (!name || name === "INDEX.md") return;
        if (!byFile.has(name)) byFile.set(name, new Set());
        for (const p of pages) byFile.get(name)!.add(p);
      };
      for (let j = start; j < end; j++) {
        const m = orderedMessages[j];
        if (m.role === "assistant") lastAssistant = m.id;
        if (m.role !== "tool_use" || !m.toolInput) continue;
        const ti = m.toolInput;
        // Read carries a precise file_path + pages — the strongest signal.
        const fp = ti.file_path;
        if (m.tool === "Read" && typeof fp === "string" && fp.startsWith("/knowledge/")) {
          const pages = String(ti.pages ?? "").match(/\d+/g)?.map(Number) ?? [];
          note(fp.slice("/knowledge/".length), pages);
        } else {
          // Any other tool (Bash pdftotext, Grep) referencing /knowledge.
          const blob = JSON.stringify(ti);
          for (const match of blob.matchAll(KNOWLEDGE_REF)) note(match[1]);
        }
      }
      if (lastAssistant && byFile.size > 0) {
        map.set(lastAssistant, Array.from(byFile, ([name, pages]) => ({
          name, pages: Array.from(pages).sort((a, b) => a - b),
        })));
      }
    };
    for (let i = 0; i < orderedMessages.length; i++) {
      if (orderedMessages[i].role === "user" && i > start) { flush(i); start = i; }
    }
    flush(orderedMessages.length);
    return map;
  }, [orderedMessages]);

  // Resolve /knowledge filenames → the actual doc (for click-to-view). Built
  // from the workspace's agent + workspace docs; names are sanitized to match
  // how the orchestrator writes them under /knowledge.
  const [docMap, setDocMap] = useState<Map<string, { scope: "profile" | "workspace"; id: string; docId: string; media_type: string; name: string }>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = new Map<string, { scope: "profile" | "workspace"; id: string; docId: string; media_type: string; name: string }>();
      try {
        if (profileId) {
          for (const d of await fetchProfileDocuments(profileId)) {
            map.set(sanitizeDocName(d.name), { scope: "profile", id: profileId, docId: d.id, media_type: d.media_type, name: d.name });
          }
        }
        if (sessionId) {
          for (const d of await fetchWorkspaceDocuments(sessionId)) {
            map.set(sanitizeDocName(d.name), { scope: "workspace", id: sessionId, docId: d.id, media_type: d.media_type, name: d.name });
          }
        }
      } catch { /* leave chips non-clickable on failure */ }
      if (!cancelled) setDocMap(map);
    })();
    return () => { cancelled = true; };
  }, [profileId, sessionId]);

  // Open a knowledge doc (by the filename the agent referenced) at a page.
  const openDoc = (file: string, page?: number | null) => {
    const doc = docMap.get(sanitizeDocName(file));
    if (!doc) return;
    setSourceViewer({
      url: doc.scope === "workspace"
        ? workspaceDocumentRawUrl(doc.id, doc.docId)
        : profileDocumentRawUrl(doc.id, doc.docId),
      mediaType: doc.media_type, name: doc.name, page: page ?? undefined,
    });
  };

  return (
    <>
      {orderedMessages.map((msg, msgIdx) => {
        // All assistant text from this point to the end of the turn (next
        // user message) — what the per-turn copy button copies. Text only:
        // tool calls/results and system/goal cards are deliberately excluded.
        const turnTextFrom = (start: number): string => {
          const parts: string[] = [];
          for (let j = start; j < orderedMessages.length; j++) {
            const m = orderedMessages[j];
            if (m.role === "user") break;
            if (m.role === "assistant" && m.content) parts.push(m.content);
          }
          return parts.join("\n\n");
        };
        const turnStartTime = turnStarters.get(msg.id);
        const isTurnStart = !!turnStartTime;
        // Header strip emitted before tool blocks that start an agent turn.
        // Assistant text bubbles already render their own header via MsgRow
        // (unless we tell them to be compact — see below).
        const headerStrip =
          isTurnStart && (msg.role === "tool_use" || msg.role === "tool_result")
            ? <AgentHeaderStrip key={`${msg.id}-hdr`} time={turnStartTime!} copyText={turnTextFrom(msgIdx) || undefined} />
            : null;
        if (!showTools && (msg.role === "tool_use" || msg.role === "tool_result")) return null;

        if (msg.role === "system" && msg.goal) {
          // Goal-loop verdict card (judge review / final outcome).
          const g = msg.goal;
          const stopTitles: Record<string, string> = {
            done: "Goal complete",
            max_iterations: "Stopped — continuation limit reached",
            budget: "Stopped — budget limit reached",
            no_progress: "Stopped — no further progress",
            judge_error: "Stopped — completion check unavailable",
            agent_error: "Stopped — a turn failed",
          };
          const ok = g.done === true;
          const accent = ok ? "var(--vz-ok)" : "var(--vz-muted)";
          const title = g.kind === "eval"
            ? (ok ? "Goal met" : `Goal review · round ${(g.iteration ?? 0) + 1}`)
            : (stopTitles[g.reason ?? ""] ?? "Goal loop stopped");
          return (
            <div key={msg.id} className="py-2">
              <div
                style={{
                  border: "1px solid var(--vz-border)",
                  borderLeft: `3px solid ${accent}`,
                  borderRadius: "var(--vz-radius-sm)",
                  background: "var(--vz-mute)",
                  padding: "8px 12px",
                  fontFamily: "var(--vz-font-sans)",
                  fontSize: 12.5,
                  color: "var(--vz-ink)",
                }}
              >
                <div className="flex items-center gap-1.5" style={{ fontWeight: 600 }}>
                  {ok
                    ? <Check className="w-3.5 h-3.5" style={{ color: accent }} />
                    : <Target className="w-3.5 h-3.5" style={{ color: accent }} />}
                  <span>{title}</span>
                  {g.kind === "stop" && typeof g.cost === "number" && (
                    <span style={{ marginLeft: "auto", fontWeight: 400, fontFamily: "var(--vz-font-mono)", fontSize: 11, color: "var(--vz-muted)" }}>
                      ${g.cost.toFixed(2)}
                    </span>
                  )}
                </div>
                {g.kind === "stop" && g.detail && (
                  <div style={{ marginTop: 4, color: "var(--vz-muted)" }}>{g.detail}</div>
                )}
                {g.kind === "eval" && g.rationale && (
                  <div style={{ marginTop: 4, color: "var(--vz-muted)" }}>{g.rationale}</div>
                )}
                {g.kind === "eval" && !ok && g.missing && g.missing.length > 0 && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 16, color: "var(--vz-muted)" }}>
                    {g.missing.map((m, i) => <li key={i} style={{ marginTop: 2 }}>{m}</li>)}
                  </ul>
                )}
              </div>
            </div>
          );
        }

        if (msg.role === "system") {
          return (
            <div key={msg.id} className="py-2">
              <div
                className="text-center"
                style={{
                  fontFamily: "var(--vz-font-mono)",
                  fontSize: 11,
                  color: "var(--vz-muted-2)",
                  letterSpacing: "0.04em",
                }}
              >
                {msg.content}
              </div>
            </div>
          );
        }

        if (msg.role === "user") {
          return (
            <MsgRow
              key={msg.id}
              avatar={<UserAvatar letter={userInitial} />}
              name="You"
              time={msg.timestamp}
              trailing={
                <CopyMsgButton
                  text={msg.content}
                  className="opacity-0 group-hover/msg:opacity-100 transition-opacity"
                />
              }
            >
              {msg.images && msg.images.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {msg.images.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt=""
                      className="rounded-md object-cover"
                      style={{
                        maxWidth: 200,
                        maxHeight: 200,
                        border: "1px solid var(--vz-border)",
                      }}
                    />
                  ))}
                </div>
              )}
              <div
                className="whitespace-pre-wrap"
                style={{ fontSize: 14, lineHeight: 1.6, color: "var(--vz-ink)" }}
              >
                {msg.content}
              </div>
              {msg.acceptanceCriteria && msg.acceptanceCriteria.length > 0 && (
                <div
                  className="mt-2 rounded-md"
                  style={{
                    fontSize: 12,
                    color: "var(--vz-ink-3)",
                    background: "var(--vz-mute)",
                    border: "1px solid var(--vz-border)",
                    padding: "6px 10px",
                  }}
                >
                  <div
                    className="inline-flex items-center gap-1.5 mb-1"
                    style={{
                      fontSize: 10.5, fontFamily: "var(--vz-font-mono)",
                      letterSpacing: "0.08em", textTransform: "uppercase",
                      color: "var(--vz-sodium)",
                    }}
                  >
                    <Target className="w-3 h-3" /> Acceptance criteria
                  </div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {msg.acceptanceCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {msg.files && msg.files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {msg.files.map((f, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5"
                      style={{
                        fontSize: 11,
                        color: "var(--vz-muted)",
                        background: "var(--vz-mute)",
                        border: "1px solid var(--vz-border)",
                        padding: "2px 8px",
                        borderRadius: 5,
                      }}
                    >
                      {f.type === "image" ? <Image className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                      <span className="max-w-[180px] truncate">{f.name}</span>
                    </span>
                  ))}
                </div>
              )}
            </MsgRow>
          );
        }

        if (msg.role === "assistant") {
          const isLastStreaming = streaming && messages[messages.length - 1]?.id === msg.id;
          // Pull the agent's structured citation block out of the prose (parsed
          // into cards below; hidden from the rendered markdown).
          const { text: cleanContent, citations } = extractCitations(msg.content);
          // Compact when this assistant bubble isn't the turn-starter — a
          // tool call already emitted the agent header above it.
          const compact = !isTurnStart;
          return (
            <MsgRow
              key={msg.id}
              avatar={<AgentAvatar />}
              name={
                <>
                  vonzio
                  <span style={{ color: "var(--vz-muted-2)", fontWeight: 400 }}> · agent</span>
                </>
              }
              time={msg.timestamp}
              compact={compact}
              trailing={
                !isLastStreaming ? (
                  <span className="flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                    {/* Copies the WHOLE turn's text (all segments), not just
                        this bubble — segments split at tool boundaries. */}
                    <CopyMsgButton text={turnTextFrom(msgIdx)} />
                    <ResponseFeedback
                      responseText={msg.content}
                      profileId={profileId}
                    />
                  </span>
                ) : undefined
              }
            >
              <div
                className={`${proseClass} prose-sm max-w-none prose-pre:bg-[var(--vz-mute)] prose-pre:border prose-pre:border-[var(--vz-border)] prose-code:before:content-none prose-code:after:content-none [&_code]:text-[color:var(--vz-sodium)] [&_pre_code]:text-[color:var(--vz-ink-2)] [&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_a]:text-[color:var(--vz-sodium)] [&_a]:underline [&_a]:break-all hover:[&_a]:opacity-80 [&_h1]:text-[color:var(--vz-ink)] [&_h2]:text-[color:var(--vz-ink)] [&_h3]:text-[color:var(--vz-ink)] [&_h4]:text-[color:var(--vz-ink)] [&_strong]:text-[color:var(--vz-ink)] [&_blockquote]:not-italic [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--vz-sodium)] [&_blockquote]:bg-[var(--vz-mute)] [&_blockquote]:rounded-r-md [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote]:my-3 [&_blockquote]:text-[color:var(--vz-ink-2)] [&_blockquote_p]:my-1 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none`}
                style={{ fontSize: 14, lineHeight: 1.65, color: "var(--vz-ink)" }}
              >
                <MarkdownContent content={cleanContent} isStreaming={isLastStreaming} />
                {isLastStreaming && (
                  <span
                    className="inline-block ml-0.5 animate-pulse rounded-sm"
                    style={{ width: 6, height: 14, background: "var(--vz-sodium)", verticalAlign: "-2px" }}
                  />
                )}
              </div>
              {/* Citations. Prefer the agent's structured citations (file · page ·
                  section + quote); otherwise fall back to the deterministic
                  Sources chips derived from its tool calls. */}
              {citations.length > 0 ? (
                <div className="flex flex-col gap-1.5 mt-3">
                  <span
                    className="inline-flex items-center gap-1"
                    style={{ fontSize: 10.5, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}
                  >
                    <BookOpen className="w-3 h-3" /> Sources
                  </span>
                  {citations.map((c, i) => {
                    const resolvable = docMap.has(sanitizeDocName(c.file));
                    return (
                      <button
                        key={`${c.file}-${i}`}
                        type="button"
                        onClick={resolvable ? () => openDoc(c.file, c.page) : undefined}
                        disabled={!resolvable}
                        className="text-left"
                        style={{
                          border: "1px solid var(--vz-border)", borderLeft: "3px solid var(--vz-sodium)",
                          borderRadius: "var(--vz-radius-sm)", background: "var(--vz-mute)",
                          padding: "6px 10px", cursor: resolvable ? "pointer" : "default",
                        }}
                        title={resolvable ? `Open ${c.file}${c.page ? ` · p.${c.page}` : ""}` : c.file}
                      >
                        <div className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: "var(--vz-ink-2)" }}>
                          <FileText className="w-3 h-3 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
                          <span className="font-medium truncate">{c.file}</span>
                          {c.page != null && <span style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>· p.{c.page}</span>}
                          {c.section && <span className="truncate" style={{ color: "var(--vz-muted-2)" }}>· {c.section}</span>}
                        </div>
                        {c.quote && (
                          <div className="mt-1" style={{ fontSize: 11.5, color: "var(--vz-muted)", fontStyle: "italic", lineHeight: 1.4 }}>
                            “{c.quote}”
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : turnSources.has(msg.id) ? (
                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  <span
                    className="inline-flex items-center gap-1"
                    style={{ fontSize: 10.5, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}
                  >
                    <BookOpen className="w-3 h-3" /> Sources
                  </span>
                  {turnSources.get(msg.id)!.map((src) => {
                    const doc = docMap.get(src.name);
                    const pageLabel = src.pages.length > 0
                      ? ` · ${src.pages.slice(0, 3).map((p) => `p.${p}`).join(", ")}${src.pages.length > 3 ? "…" : ""}`
                      : "";
                    const open = doc
                      ? () => setSourceViewer({
                          url: doc.scope === "workspace"
                            ? workspaceDocumentRawUrl(doc.id, doc.docId)
                            : profileDocumentRawUrl(doc.id, doc.docId),
                          mediaType: doc.media_type, name: doc.name,
                          page: src.pages[0],
                        })
                      : undefined;
                    return (
                      <button
                        key={src.name}
                        type="button"
                        onClick={open}
                        disabled={!open}
                        className="inline-flex items-center gap-1 max-w-[260px]"
                        style={{
                          fontSize: 11, color: "var(--vz-ink-3)",
                          background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
                          padding: "2px 8px", borderRadius: 5,
                          cursor: open ? "pointer" : "default",
                        }}
                        title={open ? `Open ${src.name}${pageLabel}` : src.name}
                      >
                        <FileText className="w-3 h-3 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
                        <span className="truncate">{src.name}</span>
                        {pageLabel && <span style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>{pageLabel}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </MsgRow>
          );
        }

        if (msg.role === "tool_use") {
          const idx = messages.indexOf(msg);
          let hasResult = false;
          for (let j = idx + 1; j < messages.length && j <= idx + 5; j++) {
            if (messages[j].role === "tool_result" && messages[j].tool === msg.tool) {
              hasResult = true;
              break;
            }
            if (messages[j].role === "tool_use" && messages[j].tool === msg.tool) break;
          }
          if (hasResult) return null;
          if (idx > 0 && messages[idx - 1].role === "tool_use" && messages[idx - 1].tool === msg.tool) {
            return null;
          }
          const isLast = idx >= messages.length - 2;
          return (
            <React.Fragment key={msg.id}>
              {headerStrip}
              <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14 }}>
                <ToolBlock tool={msg.tool ?? ""} input={msg.toolInput} pending={isLast && streaming} containerId={containerId} />
              </div>
            </React.Fragment>
          );
        }

        if (msg.role === "tool_result") {
          const idx = messages.indexOf(msg);
          let toolInput: Record<string, unknown> | undefined;
          for (let j = idx - 1; j >= 0 && j >= idx - 5; j--) {
            if (messages[j].role === "tool_use" && messages[j].tool === msg.tool) {
              toolInput = messages[j].toolInput;
              break;
            }
          }

          // Bash/Read/Write with CSV: show collapsed tool block + standalone table
          if (msg.tool === "Bash" || msg.tool === "Read" || msg.tool === "Write") {
            // 1. Try inline CSV from stdout
            let textToCheck = msg.content;
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed?.stdout) textToCheck = parsed.stdout;
              else if (parsed?.file?.content) textToCheck = parsed.file.content;
              else if (parsed?.content) textToCheck = parsed.content;
            } catch { /* use raw */ }
            const table = detectCSV(textToCheck);
            if (table) {
              const fileName = (toolInput?.file_path as string)?.split("/").pop()
                ?? (toolInput?.command as string)?.match(/([^\s/]+\.csv)/i)?.[1]
                ?? "Output";
              return (
                <React.Fragment key={msg.id}>
                  {headerStrip}
                  <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14 }}>
                    <ToolBlock tool={msg.tool} input={toolInput} containerId={containerId} />
                    <div
                      className="mt-1 overflow-hidden text-[11px]"
                      style={{
                        border: "1px solid var(--vz-border)",
                        borderRadius: "var(--vz-radius-md)",
                      }}
                    >
                      <TableView table={table} title={fileName} />
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            // 2. Check if a .csv file was written — fetch and render it
            const csvPath = extractCSVFilePath(msg, toolInput);
            if (csvPath && containerId) {
              const csvFileName = csvPath.split("/").pop() ?? "data.csv";
              return (
                <React.Fragment key={msg.id}>
                  {headerStrip}
                  <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14 }}>
                    <ToolBlock tool={msg.tool} input={toolInput} containerId={containerId} />
                    <div className="mt-1">
                      <RemoteCSVTable containerId={containerId} filePath={csvPath} title={csvFileName} />
                    </div>
                  </div>
                </React.Fragment>
              );
            }
          }

          return (
            <React.Fragment key={msg.id}>
              {headerStrip}
              <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14 }}>
                <ToolBlock tool={msg.tool ?? ""} input={toolInput} output={msg.content} containerId={containerId} />
              </div>
            </React.Fragment>
          );
        }

        return null;
      })}
      {sourceViewer && <DocViewerModal target={sourceViewer} onClose={() => setSourceViewer(null)} />}
    </>
  );
}

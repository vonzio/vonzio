import React, { useState, useEffect, useMemo } from "react";
import { Image, FileText, Loader2 } from "lucide-react";
import { type ChatMessage, ToolBlock, MarkdownContent, detectCSV, TableView } from "./ChatCore.js";
import { ResponseFeedback } from "./ResponseFeedback.js";
import { useOptionalUser } from "../contexts/UserContext.js";
import { useTheme } from "../hooks/useTheme.js";

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
  divider = true,
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
function AgentHeaderStrip({ time }: { time: Date }) {
  return (
    <div
      className="animate-[fadeIn_0.2s_ease-out]"
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
      </div>
    </div>
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
}: {
  messages: ChatMessage[];
  showTools: boolean;
  streaming: boolean;
  containerId: string | null;
  profileId?: string;
}) {
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

  // Per-turn render reorder + grouping. Two things happen here:
  //
  // 1) Reorder within each turn: tools/results come BEFORE assistant text
  //    bubbles. Live event order can put the assistant bubble first (its
  //    creation is tied to the first streamed token, which the SDK can
  //    emit *before* the tool_use event lands). Reordering at render time
  //    keeps the visual layout chronologically correct (tools ran first,
  //    text came after) regardless of array order.
  //
  // 2) Identify which message owns the agent header for each turn. We
  //    skip messages that the existing dedup hides (tool_use followed by
  //    a matching tool_result) so the header lands on whatever ACTUALLY
  //    renders — not on a phantom row.
  const orderedMessages = useMemo(() => {
    const result: ChatMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === "user") {
        result.push(msg);
        i++;
        const turn: ChatMessage[] = [];
        while (i < messages.length && messages[i].role !== "user") {
          turn.push(messages[i]);
          i++;
        }
        // Stable partition: tools first (in their original order), then
        // assistant texts, then any system markers — all preserved
        // internally chronological.
        const tools = turn.filter((m) => m.role === "tool_use" || m.role === "tool_result");
        const texts = turn.filter((m) => m.role === "assistant");
        const other = turn.filter((m) => m.role !== "tool_use" && m.role !== "tool_result" && m.role !== "assistant");
        result.push(...tools, ...texts, ...other);
      } else {
        result.push(msg);
        i++;
      }
    }
    return result;
  }, [messages]);

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

  return (
    <>
      {orderedMessages.map((msg) => {
        const turnStartTime = turnStarters.get(msg.id);
        const isTurnStart = !!turnStartTime;
        // Header strip emitted before tool blocks that start an agent turn.
        // Assistant text bubbles already render their own header via MsgRow
        // (unless we tell them to be compact — see below).
        const headerStrip =
          isTurnStart && (msg.role === "tool_use" || msg.role === "tool_result")
            ? <AgentHeaderStrip key={`${msg.id}-hdr`} time={turnStartTime!} />
            : null;
        if (!showTools && (msg.role === "tool_use" || msg.role === "tool_result")) return null;

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
                  <ResponseFeedback
                    responseText={msg.content}
                    profileId={profileId}
                    className="opacity-0 group-hover/msg:opacity-100 transition-opacity"
                  />
                ) : undefined
              }
            >
              <div
                className={`${proseClass} prose-sm max-w-none prose-pre:bg-[var(--vz-mute)] prose-pre:border prose-pre:border-[var(--vz-border)] prose-code:before:content-none prose-code:after:content-none [&_code]:text-[color:var(--vz-sodium)] [&_pre_code]:text-[color:var(--vz-ink-2)] [&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_a]:text-[color:var(--vz-sodium)] [&_a]:underline [&_a]:break-all hover:[&_a]:opacity-80 [&_h1]:text-[color:var(--vz-ink)] [&_h2]:text-[color:var(--vz-ink)] [&_h3]:text-[color:var(--vz-ink)] [&_h4]:text-[color:var(--vz-ink)] [&_strong]:text-[color:var(--vz-ink)] [&_blockquote]:not-italic [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--vz-sodium)] [&_blockquote]:bg-[var(--vz-mute)] [&_blockquote]:rounded-r-md [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote]:my-3 [&_blockquote]:text-[color:var(--vz-ink-2)] [&_blockquote_p]:my-1 [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none`}
                style={{ fontSize: 14, lineHeight: 1.65, color: "var(--vz-ink)" }}
              >
                <MarkdownContent content={msg.content} isStreaming={isLastStreaming} />
                {isLastStreaming && (
                  <span
                    className="inline-block ml-0.5 animate-pulse rounded-sm"
                    style={{ width: 6, height: 14, background: "var(--vz-sodium)", verticalAlign: "-2px" }}
                  />
                )}
              </div>
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
              <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14, borderBottom: "1px solid var(--vz-border)" }}>
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
                  <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14, borderBottom: "1px solid var(--vz-border)" }}>
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
                  <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14, borderBottom: "1px solid var(--vz-border)" }}>
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
              <div style={{ paddingLeft: ROW_INDENT, paddingBottom: 14, borderBottom: "1px solid var(--vz-border)" }}>
                <ToolBlock tool={msg.tool ?? ""} input={toolInput} output={msg.content} containerId={containerId} />
              </div>
            </React.Fragment>
          );
        }

        return null;
      })}
    </>
  );
}

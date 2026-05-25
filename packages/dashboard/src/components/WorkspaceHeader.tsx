import { useEffect, useState } from "react";
import { Loader2, Pencil, PanelRightOpen, PanelRightClose, Download, Menu, Send } from "lucide-react";
import { Pill } from "@/brand/components.js";
import { fetchProfileModels, fetchTelegramBotForWorkspace, type ProfileModel, type TelegramBotForWorkspace } from "@/api/client.js";
import { MODEL_DISPLAY_FALLBACK } from "@/lib/model-display.js";
import type { ChatMessage } from "./ChatCore.js";

interface Props {
  name: string | null;
  sessionId?: string;
  status: string;
  connected: boolean;
  streaming: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onToggleSidebar?: () => void;
  onRename: (name: string) => void;
  messages: ChatMessage[];
  workspaceName: string;
  profileName?: string;
  /** Active workspace model override (null when running on profile default). */
  modelOverride?: string | null;
  /** Profile's own default model — shown when there's no override. */
  profileDefaultModel?: string | null;
  /** Active profile id; used to resolve model display names. */
  profileId?: string;
}

// Map workspace status → status-pip color (left of the workspace name).
function pipColor(status: string, connected: boolean): string {
  if (!connected) return "var(--vz-fail)";
  switch (status) {
    case "active": case "running": return "var(--vz-sodium)";
    case "idle": return "var(--vz-info)";
    case "paused": case "resumable": return "var(--vz-warn)";
    case "completed": return "var(--vz-ok)";
    case "failed": return "var(--vz-fail)";
    default: return "var(--vz-muted-2)";
  }
}

function exportAsMarkdown(messages: ChatMessage[], workspaceName: string) {
  let md = `# ${workspaceName}\n\n---\n`;
  for (const msg of messages) {
    if (msg.role === "user") {
      md += `\n**User:** ${msg.content}\n`;
    } else if (msg.role === "assistant") {
      md += `\n**Assistant:** ${msg.content}\n`;
    } else if (msg.role === "tool_result") {
      const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
      md += `\n> Tool: ${msg.tool ?? "unknown"}\n> ${truncated.replace(/\n/g, "\n> ")}\n`;
    }
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${workspaceName}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function WorkspaceHeader({
  name, sessionId, status, connected, streaming,
  panelOpen, onTogglePanel, onToggleSidebar, onRename,
  messages, workspaceName, profileName, modelOverride, profileDefaultModel, profileId,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name ?? "");
  const [models, setModels] = useState<ProfileModel[]>([]);
  // Telegram bot to deep-link this workspace into (if the user has one linked).
  // null when the user has no linked bot; the button stays hidden.
  const [tgBot, setTgBot] = useState<TelegramBotForWorkspace | null>(null);

  // Load profile models so we can render a friendly display name in the readout.
  useEffect(() => {
    if (!profileId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    fetchProfileModels(profileId)
      .then((res) => {
        if (!cancelled) setModels(res.models ?? []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // Resolve the best Telegram bot to deep-link this workspace into. The
  // server picks one bound to the workspace's profile if possible. A 404
  // (workspace not found / no linked bots) leaves tgBot null and the
  // button stays hidden.
  useEffect(() => {
    if (!sessionId) { setTgBot(null); return; }
    let cancelled = false;
    fetchTelegramBotForWorkspace(sessionId)
      .then((res) => { if (!cancelled) setTgBot(res.bot); })
      .catch(() => { if (!cancelled) setTgBot(null); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const overridden = !!modelOverride;
  const resolvedModelLabel = (() => {
    const resolveId = (id: string) => {
      const hit = models.find((m) => m.id === id);
      return hit?.display_name ?? MODEL_DISPLAY_FALLBACK[id] ?? id;
    };
    if (modelOverride) return resolveId(modelOverride);
    if (profileDefaultModel) return resolveId(profileDefaultModel);
    return "default";
  })();

  function handleSubmit() {
    if (editValue.trim()) {
      onRename(editValue.trim());
    }
    setEditing(false);
  }

  const statusLabel = connected ? status : "disconnected";
  const statusTone =
    !connected ? ("fail" as const)
    : status === "active" ? ("ok" as const)
    : status === "paused" ? ("warn" as const)
    : undefined;
  const idShort = sessionId ? sessionId.slice(0, 8) : null;

  return (
    <div
      className="flex items-center justify-between gap-2"
      style={{
        padding: "0 14px",
        height: 44,
        flexShrink: 0,
        borderBottom: "1px solid var(--vz-border)",
        background: "var(--vz-page)",
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Sidebar toggle — mobile only */}
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="lg:hidden vz-action-btn"
            style={{ marginLeft: -4 }}
          >
            <Menu className="w-4 h-4" />
          </button>
        )}

        {/* Status pip */}
        <span
          aria-hidden="true"
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: pipColor(status, connected),
            flexShrink: 0,
            ...(status === "active" && connected ? { animation: "vz-pulse 1.6s ease-in-out infinite" } : {}),
          }}
          title={statusLabel}
        />

        {/* Name (editable) */}
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="flex items-center gap-2 min-w-0">
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              autoFocus
              className="vz-input"
              style={{ fontSize: 14, fontWeight: 600, padding: "4px 8px" }}
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => { setEditValue(name ?? ""); setEditing(true); }}
            className="flex items-center gap-1.5 truncate min-w-0"
            style={{
              fontSize: 14, fontWeight: 600,
              color: "var(--vz-ink)",
              background: "none", border: 0, padding: 0,
              cursor: "pointer",
              letterSpacing: "-0.01em",
            }}
          >
            <span className="truncate">{name ?? "Untitled"}</span>
            <Pencil className="w-3 h-3 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
          </button>
        )}

        {/* Session ID badge (mono chip) */}
        {idShort && (
          <span
            title={sessionId}
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11,
              color: "var(--vz-muted)",
              background: "var(--vz-mute)",
              border: "1px solid var(--vz-border)",
              padding: "2px 8px",
              borderRadius: 5,
              flexShrink: 0,
              letterSpacing: "0.02em",
            }}
          >
            ~{idShort}
          </span>
        )}

        {/* Model readout — read-only; the picker lives in the composer footer. */}
        <span
          className="hidden md:inline-flex"
          aria-label="Active model"
          title={overridden ? `Override: ${resolvedModelLabel}` : "Profile default model"}
          style={{
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            color: "var(--vz-muted-2)",
            letterSpacing: "0.04em",
            flexShrink: 0,
            alignItems: "center",
            gap: 4,
          }}
        >
          <span>model:</span>
          <span style={{ color: overridden ? "var(--vz-sodium)" : "var(--vz-muted-2)" }}>
            {resolvedModelLabel}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs shrink-0">
        {/* Status pill */}
        <Pill tone={statusTone} dot={connected && (status === "active" || status === "running")}>
          {statusLabel}
        </Pill>

        {streaming && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: "var(--vz-sodium)" }} />}

        {profileName && (
          <span
            className="hidden md:inline"
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11.5,
              color: "var(--vz-muted)",
              padding: "0 6px",
              letterSpacing: "0.02em",
            }}
          >
            {profileName}
          </span>
        )}

        <button
          type="button"
          onClick={() => exportAsMarkdown(messages, workspaceName)}
          className="vz-action-btn"
          style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 12 }}
          title="Export as Markdown"
        >
          <Download className="w-3 h-3" />
          <span className="hidden sm:inline">Export</span>
        </button>

        {tgBot && (
          <a
            href={tgBot.deep_link}
            target="_blank"
            rel="noopener noreferrer"
            className="vz-action-btn"
            style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 12, textDecoration: "none" }}
            title={`Continue in Telegram via @${tgBot.bot_username}${tgBot.matched_by_profile ? " (bound to this agent)" : ""}`}
          >
            <Send className="w-3 h-3" />
            <span className="hidden sm:inline">Telegram</span>
          </a>
        )}

        <button
          type="button"
          onClick={onTogglePanel}
          className="vz-action-btn"
          data-active={panelOpen ? "true" : undefined}
          style={{
            width: "auto", padding: "0 8px", gap: 5, fontSize: 12,
            color: panelOpen ? "var(--vz-sodium)" : "var(--vz-muted)",
            background: panelOpen ? "var(--vz-sodium-08)" : "transparent",
          }}
          title={panelOpen ? "Hide panel" : "Show panel"}
        >
          {panelOpen ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}
          <span className="hidden sm:inline">Panel</span>
        </button>
      </div>
    </div>
  );
}

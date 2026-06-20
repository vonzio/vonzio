import { useState } from "react";
import { Loader2, Pencil, PanelRightOpen, PanelRightClose, Download, Menu, Shield, Copy, Check, RotateCw, Wifi, WifiOff } from "lucide-react";
import { Pill } from "@/brand/components.js";
import { restartWorkspace } from "@/api/client.js";
import { getWorkspaceHeaderSlots } from "@/registry/index.js";
import { useEntitlements } from "@vonzio/dashboard-registry";
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
  /** VPN tunnel routing this workspace's agent, if any. SaaS-only:
   *  OSS workspaces always pass undefined and no pill renders. */
  attachedTunnel?: { id: string; name: string } | null;
  /** Passed through to registry-injected header slots (e.g. the
   *  cp-dashboard VPN tunnel picker). */
  profileIdForSlot?: string;
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

function buildMarkdown(messages: ChatMessage[], workspaceName: string): string {
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
  return md;
}

function exportAsMarkdown(messages: ChatMessage[], workspaceName: string) {
  const md = buildMarkdown(messages, workspaceName);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${workspaceName}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

export function WorkspaceHeader({
  name, sessionId, status, connected, streaming,
  panelOpen, onTogglePanel, onToggleSidebar, onRename,
  messages, workspaceName, profileName,
  attachedTunnel, profileIdForSlot,
}: Props) {
  const entitlements = useEntitlements();
  const headerSlots = getWorkspaceHeaderSlots().filter(
    (s) => !s.entitlement || entitlements.includes(s.entitlement),
  );
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name ?? "");
  const [convoCopied, setConvoCopied] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  // The "Open in Telegram" deep-link button moved to
  // @vonzio/plugin-telegram/dashboard/WorkspaceHeaderTelegramButton.tsx
  // in Phase 3D.1e -- rendered via the registerWorkspaceHeaderSlot
  // contribution alongside other header slots below.

  function handleSubmit() {
    if (editValue.trim()) {
      onRename(editValue.trim());
    }
    setEditing(false);
  }

  const statusLabel = connected ? status : "disconnected";

  // Running session token/cost total (sum of per-turn usage on assistant messages).
  const sessionUsage = messages.reduce(
    (a, m) => m.usage ? { in: a.in + m.usage.input_tokens, out: a.out + m.usage.output_tokens, cost: a.cost + m.usage.cost_usd } : a,
    { in: 0, out: 0, cost: 0 },
  );

  return (
    <div
      className="vz-wsh flex items-center justify-between gap-2"
      style={{
        padding: "0 14px",
        height: 44,
        flexShrink: 0,
        borderBottom: "1px solid var(--vz-border)",
        background: "var(--vz-page)",
        // Container query context: collapse the header by the ACTUAL pane width
        // (not the viewport) so it degrades cleanly when the Deck/Preview panel
        // splits the screen — viewport breakpoints can't see the narrow pane.
        containerType: "inline-size",
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

        {/* Session ID badge + model readout removed — the id is internal
            chrome and the model picker already lives in the composer footer. */}
      </div>

      <div className="flex items-center gap-1.5 text-xs shrink-0">
        {/* WebSocket/connection status — icon only, tooltip carries the label. */}
        <span
          className="vz-wsh-status"
          title={statusLabel}
          aria-label={`Status: ${statusLabel}`}
          style={{ display: "inline-flex", alignItems: "center", color: pipColor(status, connected) }}
        >
          {connected
            ? <Wifi className="w-3.5 h-3.5" />
            : <WifiOff className="w-3.5 h-3.5" />}
        </span>

        {(sessionUsage.in > 0 || sessionUsage.out > 0) && (
          <span
            className="vz-wsh-usage hidden sm:inline-flex items-center gap-1.5"
            title={`Session total — input ${sessionUsage.in.toLocaleString()} · output ${sessionUsage.out.toLocaleString()} tokens${sessionUsage.cost > 0 ? ` · $${sessionUsage.cost.toFixed(sessionUsage.cost < 0.01 ? 4 : 2)}` : ""}`}
            style={{ fontFamily: "var(--vz-font-mono)", fontSize: 10.5, color: "var(--vz-muted-2)", letterSpacing: "0.03em" }}
          >
            <span>↑ {fmtTokens(sessionUsage.in)}</span>
            <span>↓ {fmtTokens(sessionUsage.out)}</span>
            {sessionUsage.cost > 0 && <span>· ${sessionUsage.cost < 0.01 ? sessionUsage.cost.toFixed(4) : sessionUsage.cost.toFixed(2)}</span>}
          </span>
        )}

        {attachedTunnel && (
          <span title={`Agent traffic routed via VPN tunnel "${attachedTunnel.name}"`} style={{ display: "inline-flex" }}>
            <Pill tone="ok">
              <Shield className="w-3 h-3 sm:mr-1" style={{ display: "inline-block", verticalAlign: "-2px" }} />
              <span className="hidden sm:inline">VPN: {attachedTunnel.name}</span>
            </Pill>
          </span>
        )}

        {sessionId && profileIdForSlot && headerSlots.map((slot) => {
          const SlotComp = slot.component;
          return (
            <SlotComp
              key={slot.id}
              workspace={{
                session_id: sessionId,
                profile_id: profileIdForSlot,
                attached_tunnel: attachedTunnel ?? null,
              }}
            />
          );
        })}

        {streaming && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: "var(--vz-sodium)" }} />}

        {profileName && (
          <span
            className="vz-wsh-profile"
            title={`Agent: ${profileName}`}
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--vz-sodium)",
              background: "var(--vz-sodium-08)",
              border: "1px solid var(--vz-sodium-25)",
              padding: "2px 8px",
              borderRadius: 5,
              letterSpacing: "0.02em",
              flexShrink: 0,
            }}
          >
            {profileName}
          </span>
        )}

        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(buildMarkdown(messages, workspaceName));
              setConvoCopied(true);
              setTimeout(() => setConvoCopied(false), 1500);
            } catch { /* clipboard unavailable (http origin) — no-op */ }
          }}
          className="vz-action-btn"
          title={convoCopied ? "Copied" : "Copy conversation as Markdown"}
          aria-label="Copy conversation as Markdown"
        >
          {convoCopied ? <Check className="w-3 h-3" style={{ color: "var(--vz-ok)" }} /> : <Copy className="w-3 h-3" />}
        </button>

        <button
          type="button"
          onClick={() => exportAsMarkdown(messages, workspaceName)}
          className="vz-action-btn"
          title="Export as Markdown"
          aria-label="Export as Markdown"
        >
          <Download className="w-3 h-3" />
        </button>

        {sessionId && (
          <button
            type="button"
            onClick={async () => {
              if (!confirmRestart) {
                setConfirmRestart(true);
                setTimeout(() => setConfirmRestart(false), 3000);
                return;
              }
              setConfirmRestart(false);
              setRestarting(true);
              try {
                await restartWorkspace(sessionId);
              } catch { /* surfaced as a failed next-message if it didn't take */ }
              setTimeout(() => setRestarting(false), 1500);
            }}
            className="vz-action-btn"
            disabled={restarting}
            style={{ color: confirmRestart ? "var(--vz-sodium)" : undefined }}
            title={
              restarting
                ? "Restarting…"
                : confirmRestart
                  ? "Click again to confirm restart"
                  : "Restart the container — applies network/egress changes; the conversation is kept and resumes on your next message"
            }
            aria-label="Restart container"
          >
            <RotateCw className={restarting ? "w-3 h-3 animate-spin" : "w-3 h-3"} />
          </button>
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
          title={panelOpen ? "Hide Deck" : "Show Deck"}
        >
          {panelOpen ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}
          <span className="vz-wsh-label">Deck</span>
        </button>
      </div>
    </div>
  );
}

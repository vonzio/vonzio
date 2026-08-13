import { useState, useEffect } from "react";
import { Globe, FolderOpen, Terminal, SquareTerminal, Info, X, Container, Bot, Copy, Check, Clock, HardDrive, Timer, BookOpen, Cpu, Wrench, ExternalLink, FileText } from "lucide-react";
import { PreviewTab } from "./PreviewTab.js";
import { DocumentTab } from "./DocumentTab.js";
import { FilesTab } from "./FilesTab.js";
import { LogsTab } from "./LogsTab.js";
import { TerminalTab } from "./TerminalTab.js";
import { KnowledgeSection } from "./KnowledgeSection.js";
import { FILE_SERVER_PORT } from "@vonzio/shared";
import { useApi } from "../hooks/useApi.js";
import { fetchProfiles, fetchUserAnthropicKeys, type ProfileSummary, type UserAnthropicKey, type WorkspacePort, type PreviewPortMode } from "../api/client.js";

type TabId = "preview" | "document" | "files" | "console" | "logs" | "knowledge" | "info";

interface Props {
  workspaceId: string;
  containerId: string | null;
  containerName: string | null;
  profileName: string;
  /** Owning agent/profile — drives the Knowledge tab (null until resolved). */
  profileId: string | null;
  workspaceStatus: string;
  persistent: boolean;
  createdAt: string;
  expiresAt: string;
  previewUrl: string | null;
  previewRefresh?: number;
  /** /workspace path of the office document shown in the Document tab (#368).
   *  The tab itself is hidden until a document exists. */
  documentFile?: string | null;
  documentRefresh?: number;
  /** Detected listening services + per-port public state. */
  ports?: WorkspacePort[];
  /** Port currently shown in the preview iframe. */
  currentPort?: number | null;
  /** Legacy container-wide "expose everything" master (read-only hint). */
  publicPreview?: boolean;
  onSelectPort?: (port: number) => void;
  onSetPortAccess?: (port: number, mode: PreviewPortMode) => void;
  buildPortUrl?: (port: number) => string;
  onRescanPorts?: () => void;
  logs: string[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onClose: () => void;
}

function CopyButton({ value, children }: { value: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1.5 transition-colors cursor-pointer"
      style={{ color: "var(--vz-ink)" }}
      title="Click to copy"
    >
      {children}
      {copied
        ? <Check className="w-3 h-3" style={{ color: "var(--vz-sodium)" }} />
        : <Copy className="w-3 h-3" style={{ color: "var(--vz-muted-2)" }} />}
    </button>
  );
}

function InfoTab({ containerId, containerName, profileName, profileId, workspaceStatus, persistent, createdAt, expiresAt }: {
  containerId: string | null;
  containerName: string | null;
  profileName: string;
  profileId: string | null;
  workspaceStatus: string;
  persistent: boolean;
  createdAt: string;
  expiresAt: string;
}) {
  const created = new Date(createdAt);
  const expires = new Date(expiresAt);
  const statusColor = workspaceStatus === "active"
    ? "var(--vz-ok)"
    : workspaceStatus === "paused"
      ? "var(--vz-warn)"
      : "var(--vz-muted-2)";

  // Resolve model + provider for this session's agent.
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const { data: keys } = useApi<UserAnthropicKey[]>(() => fetchUserAnthropicKeys());
  const profile = (profiles ?? []).find((p) => p.id === profileId);
  const key = profile ? (keys ?? []).find((k) => k.id === profile.api_key_id) : undefined;
  const model = profile?.model || "Default";
  const provider = key?.provider;
  const toolCount = profile?.default_tools?.length ?? 0;

  const labelStyle = { color: "var(--vz-muted)" };
  const valueStyle = { color: "var(--vz-ink)" };
  const iconStyle = { color: "var(--vz-muted-2)" };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="divide-y divide-[var(--vz-border)]">
        {/* Agent */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Agent</span>
          <div className="flex items-center gap-1.5">
            <Bot className="w-3.5 h-3.5" style={{ color: "var(--vz-sodium)" }} />
            <span className="text-sm font-medium" style={valueStyle}>{profileName}</span>
          </div>
        </div>

        {/* Model */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Model</span>
          <div className="flex items-center gap-1.5">
            <Cpu className="w-3 h-3" style={iconStyle} />
            <span className="font-mono text-xs truncate max-w-[180px]" style={valueStyle}>{model}</span>
          </div>
        </div>

        {/* Provider */}
        {provider && (
          <div className="flex items-center justify-between py-3">
            <span className="text-xs" style={labelStyle}>Provider</span>
            <span className="text-xs" style={valueStyle}>{provider}{key?.name ? ` · ${key.name}` : ""}</span>
          </div>
        )}

        {/* Tools */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Tools</span>
          <div className="flex items-center gap-1.5">
            <Wrench className="w-3 h-3" style={iconStyle} />
            <span className="text-xs" style={valueStyle}>{toolCount > 0 ? `${toolCount} enabled` : "Default"}</span>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Status</span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
            <span className="text-xs capitalize" style={valueStyle}>{workspaceStatus}</span>
          </div>
        </div>

        {/* Workspace files — open the in-container file server in a new tab.
            The /preview proxy authenticates via the session cookie and mints
            the _pvt token on redirect (FILE_SERVER_PORT = the workspace file server). */}
        {containerId && (
          <div className="flex items-center justify-between py-3">
            <span className="text-xs" style={labelStyle}>Files</span>
            <button
              onClick={() => window.open(`/preview/${containerId}/${(window as unknown as { __VONZIO_FILE_SERVER_PORT?: number }).__VONZIO_FILE_SERVER_PORT ?? FILE_SERVER_PORT}/`, "_blank", "noopener")}
              className="flex items-center gap-1.5 cursor-pointer"
              style={{ color: "var(--vz-sodium)" }}
              title="Browse this workspace's files in a new tab"
            >
              <ExternalLink className="w-3 h-3" />
              <span className="text-xs">Open in browser</span>
            </button>
          </div>
        )}

        {/* Container name */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Container</span>
          <div className="flex items-center gap-1.5">
            <Container className="w-3 h-3" style={iconStyle} />
            <span className="text-xs" style={valueStyle}>{containerName ?? "—"}</span>
          </div>
        </div>

        {/* Container ID */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>ID</span>
          {containerId ? (
            <CopyButton value={containerId}>
              <span className="font-mono text-xs truncate max-w-[160px]" style={valueStyle}>{containerId.slice(0, 12)}</span>
            </CopyButton>
          ) : (
            <span className="text-xs font-mono" style={labelStyle}>—</span>
          )}
        </div>

        {/* Storage */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Storage</span>
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3 h-3" style={iconStyle} />
            <span
              className="text-xs"
              style={{
                color: persistent ? "var(--vz-sodium)" : "var(--vz-ink)",
                fontWeight: persistent ? 500 : 400,
              }}
            >
              {persistent ? "Persistent" : "Ephemeral"}
            </span>
          </div>
        </div>

        {/* Created */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Created</span>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" style={iconStyle} />
            <span className="text-xs" style={valueStyle}>{created.toLocaleDateString()} {created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </div>

        {/* Expires */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Expires</span>
          <div className="flex items-center gap-1.5">
            <Timer className="w-3 h-3" style={iconStyle} />
            <span className="text-xs" style={valueStyle}>{expires.toLocaleDateString()} {expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const tabDefs: Array<{ value: TabId; label: string; icon: typeof Globe }> = [
  { value: "preview", label: "Preview", icon: Globe },
  { value: "document", label: "Document", icon: FileText },
  { value: "files", label: "Files", icon: FolderOpen },
  { value: "console", label: "Console", icon: SquareTerminal },
  { value: "knowledge", label: "Knowledge", icon: BookOpen },
  { value: "logs", label: "Logs", icon: Terminal },
  { value: "info", label: "Info", icon: Info },
];

export function RightPanel({
  workspaceId, containerId, containerName, profileName, profileId, workspaceStatus, persistent, createdAt, expiresAt,
  previewUrl, previewRefresh, documentFile, documentRefresh, ports, currentPort, publicPreview, onSelectPort, onSetPortAccess, buildPortUrl, onRescanPorts,
  logs, activeTab, onTabChange, onClose,
}: Props) {
  // The Console mounts lazily on first open, then stays mounted (hidden when
  // another tab is active) so its shells survive tab switches.
  const [consoleMounted, setConsoleMounted] = useState(false);
  useEffect(() => { if (activeTab === "console") setConsoleMounted(true); }, [activeTab]);

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--vz-page)" }}>
      {/* Tab header row — same 44px height as WorkspaceHeader on the left so
          the two halves visually read as a single continuous strip across
          the top of the page. The vz-tabs__list border-bottom matches the
          WorkspaceHeader border-bottom. */}
      <div
        className="vz-tabs__list"
        role="tablist"
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 4px",
          height: 44,
          flexShrink: 0,
          // Safety net for extreme narrow widths; icon-only-inactive (below)
          // means it almost never actually scrolls.
          overflowX: "auto",
          minWidth: 0,
        }}
      >
        {tabDefs.map((t) => {
          // The Document tab only exists once a document does — an empty tab
          // in every workspace would be noise.
          if (t.value === "document" && !documentFile) return null;
          const active = activeTab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              className="vz-tabs__trigger"
              data-active={active}
              onClick={() => onTabChange(t.value)}
              // Inactive tabs collapse to icon-only (with a tooltip) so all tabs
              // fit; the active tab keeps its label. aria-label keeps a11y intact.
              title={t.label}
              aria-label={t.label}
              style={{ display: "inline-flex", alignItems: "center", gap: active ? 6 : 0, padding: active ? "0 12px" : "0 9px", height: "100%", fontSize: 13, flexShrink: 0 }}
            >
              <t.icon size={14} />
              {active && t.label}
            </button>
          );
        })}
        <button
          onClick={onClose}
          className="vz-action-btn"
          style={{ marginLeft: "auto", marginRight: 4 }}
          aria-label="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === "preview" && (
          <PreviewTab
            url={previewUrl}
            refreshTrigger={previewRefresh}
            ports={ports}
            currentPort={currentPort}
            publicPreview={publicPreview}
            onSelectPort={onSelectPort}
            onSetPortAccess={onSetPortAccess}
            buildPortUrl={buildPortUrl}
            onRescanPorts={onRescanPorts}
          />
        )}
        {activeTab === "document" && (
          <DocumentTab containerId={containerId} filePath={documentFile ?? null} refreshTrigger={documentRefresh} />
        )}
        {activeTab === "files" && (
          // flex column (not overflow-auto) so FilesTab's `flex-1` fills the full
          // panel height — otherwise it collapses to content height and the
          // drag-drop overlay only covers the small file area. FilesTab scrolls
          // its own list internally.
          <div className="flex-1 min-h-0 flex flex-col">
            <FilesTab workspaceId={workspaceId} containerId={containerId} />
          </div>
        )}
        {activeTab === "knowledge" && (
          <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
            <div>
              <div
                className="mb-2"
                style={{ fontSize: 11, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}
              >
                This workspace
              </div>
              <KnowledgeSection scope="workspace" sessionId={workspaceId} />
            </div>
            <div>
              <div
                className="mb-2"
                style={{ fontSize: 11, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}
              >
                Agent · {profileName}
              </div>
              <KnowledgeSection scope="agent" profileId={profileId} />
            </div>
          </div>
        )}
        {/* Mounted persistently (once opened) so running shells survive tab
            switches; only displayed when Console is the active tab. */}
        {consoleMounted && (
          <div
            className="flex-1 min-h-0 flex-col"
            style={{ display: activeTab === "console" ? "flex" : "none" }}
          >
            <TerminalTab workspaceId={workspaceId} containerId={containerId} active={activeTab === "console"} />
          </div>
        )}
        {activeTab === "logs" && <LogsTab logs={logs} />}
        {activeTab === "info" && (
          <InfoTab
            containerId={containerId}
            containerName={containerName}
            profileName={profileName}
            profileId={profileId}
            workspaceStatus={workspaceStatus}
            persistent={persistent}
            createdAt={createdAt}
            expiresAt={expiresAt}
          />
        )}
      </div>
    </div>
  );
}

export type { TabId };

import { useState } from "react";
import { Globe, FolderOpen, Terminal, Info, X, Container, Bot, Copy, Check, Clock, HardDrive, Timer } from "lucide-react";
import { PreviewTab } from "./PreviewTab.js";
import { FilesTab } from "./FilesTab.js";
import { LogsTab } from "./LogsTab.js";

type TabId = "preview" | "files" | "logs" | "info";

interface Props {
  workspaceId: string;
  containerId: string | null;
  containerName: string | null;
  profileName: string;
  workspaceStatus: string;
  persistent: boolean;
  createdAt: string;
  expiresAt: string;
  previewUrl: string | null;
  previewRefresh?: number;
  isPublicPreview?: boolean;
  onTogglePublicPreview?: (isPublic: boolean) => void;
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

function InfoTab({ containerId, containerName, profileName, workspaceStatus, persistent, createdAt, expiresAt }: {
  containerId: string | null;
  containerName: string | null;
  profileName: string;
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

        {/* Status */}
        <div className="flex items-center justify-between py-3">
          <span className="text-xs" style={labelStyle}>Status</span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
            <span className="text-xs capitalize" style={valueStyle}>{workspaceStatus}</span>
          </div>
        </div>

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
  { value: "files", label: "Files", icon: FolderOpen },
  { value: "logs", label: "Logs", icon: Terminal },
  { value: "info", label: "Info", icon: Info },
];

export function RightPanel({
  workspaceId, containerId, containerName, profileName, workspaceStatus, persistent, createdAt, expiresAt,
  previewUrl, previewRefresh, isPublicPreview, onTogglePublicPreview, logs, activeTab, onTabChange, onClose,
}: Props) {
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
        }}
      >
        {tabDefs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            className="vz-tabs__trigger"
            data-active={activeTab === t.value}
            onClick={() => onTabChange(t.value)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "0 12px", height: "100%", fontSize: 13 }}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
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
          <PreviewTab url={previewUrl} refreshTrigger={previewRefresh} isPublic={isPublicPreview} onTogglePublic={onTogglePublicPreview} />
        )}
        {activeTab === "files" && (
          <div className="flex-1 min-h-0 overflow-auto">
            <FilesTab workspaceId={workspaceId} containerId={containerId} />
          </div>
        )}
        {activeTab === "logs" && <LogsTab logs={logs} />}
        {activeTab === "info" && (
          <InfoTab
            containerId={containerId}
            containerName={containerName}
            profileName={profileName}
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

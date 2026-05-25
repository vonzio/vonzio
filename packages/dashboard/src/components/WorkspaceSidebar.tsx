import { useMemo, useState } from "react";
import { Plus, ChevronRight, Star, Archive, Trash2, MessageSquare, CheckCircle2, Clock } from "lucide-react";
import type { GroupedWorkspaces } from "../hooks/useWorkspaces.js";
import type { WorkspaceSummary } from "../api/client.js";
import { Modal, Button } from "@/brand/components.js";
import { cn } from "@/lib/utils";

interface Props {
  grouped: GroupedWorkspaces;
  activeId: string | null;
  onSelect: (workspace: WorkspaceSummary) => void;
  onCreate: () => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  inSheet?: boolean;
}

// ─── Time + status helpers ────────────────────────────────────────────

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

/** Live: short relative — `now`, `14s`, `2m`, `1h`. */
function formatLiveTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 5_000) return "now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Today: clock — `9:14`. */
function formatClockTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false });
}

/** Earlier: short date — `May 7` or `Mar 14`. */
function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "Stuck" reads better than "paused" for ambiguous mid-states (resumable
// containers, idle sessions waiting on input).
function statusLabel(status: string): string | null {
  switch (status) {
    case "paused": case "resumable": return "stuck";
    case "failed": return "failed";
    case "completed": return null; // green pip is enough
    default: return null;
  }
}

function pipColor(w: WorkspaceSummary): string {
  if (w.archived) return "var(--vz-muted-2)";
  switch (w.status) {
    case "active": case "running": return "var(--vz-sodium)";
    case "idle": return "var(--vz-info)";
    case "paused": case "resumable": return "var(--vz-warn)";
    case "completed": return "var(--vz-ok)";
    case "failed": return "var(--vz-fail)";
    default: return "var(--vz-muted-2)";
  }
}

function pipPulse(w: WorkspaceSummary): boolean {
  return !w.archived && (w.status === "active" || w.status === "running");
}

function isFinished(w: WorkspaceSummary): boolean {
  if (w.archived) return true;
  // `expired` is the ACTUAL terminal status set by SessionRegistry when
  // a session's idle TTL elapses and the container is reaped. The DB
  // had 91 expired workspaces for the admin user that were invisible
  // until this fix because no filter caught the real status. Kept the
  // legacy completed/failed/cancelled too in case those ever get wired.
  if (w.status === "expired" || w.status === "completed" || w.status === "failed" || w.status === "cancelled") {
    return true;
  }
  // Time-based fallback for non-terminal statuses: idle/paused/resumable
  // workspaces not touched today are also history.
  if ((w.status === "idle" || w.status === "paused" || w.status === "resumable") && !isToday(w.last_active_at)) {
    return true;
  }
  return false;
}

// ─── Component ────────────────────────────────────────────────────────

export function WorkspaceSidebar({ grouped, activeId, onSelect, onCreate, onUpdate, onDelete, inSheet }: Props) {
  // No section is collapsed by default. The user's complaint on v0.1.79
  // was "can't see past workspaces" — pre-collapsing the section that
  // actually contains them was half the problem (the other half was the
  // time-based isFinished fix below). Sections still auto-hide when
  // empty (see `Section` component), so an open-by-default Earlier won't
  // clutter the sidebar for users without history.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Re-bucket the four useWorkspaces categories into LIVE / TODAY / EARLIER.
  // The legacy `archived` group already contains finished items; the others
  // hold live ones.
  const { live, today, earlier } = useMemo(() => {
    const all: WorkspaceSummary[] = [
      ...grouped.starred,
      ...grouped.active,
      ...grouped.paused,
      ...grouped.archived,
    ];
    const dedup = Array.from(new Map(all.map((w) => [w.session_id, w])).values());
    const sortByActive = (a: WorkspaceSummary, b: WorkspaceSummary) => b.last_active_at.localeCompare(a.last_active_at);
    return {
      live: dedup.filter((w) => !isFinished(w)).sort(sortByActive),
      today: dedup.filter((w) => isFinished(w) && isToday(w.last_active_at)).sort(sortByActive),
      earlier: dedup.filter((w) => isFinished(w) && !isToday(w.last_active_at)).sort(sortByActive),
    };
  }, [grouped]);

  function ChatItem({ workspace, group }: { workspace: WorkspaceSummary; group: "live" | "today" | "earlier" }) {
    const isActive = workspace.session_id === activeId;
    const name = workspace.name ?? workspace.session_id.slice(0, 8);
    const status = statusLabel(workspace.status);
    const time = group === "live"
      ? formatLiveTime(workspace.last_active_at)
      : group === "today"
        ? formatClockTime(workspace.last_active_at)
        : formatShortDate(workspace.last_active_at);

    return (
      <div
        className="group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer text-[13px] transition-colors mx-1.5"
        style={{
          color: isActive ? "var(--vz-ink)" : "var(--vz-ink-3)",
          background: isActive ? "var(--vz-card)" : "transparent",
          border: isActive ? "1px solid var(--vz-border)" : "1px solid transparent",
          fontWeight: isActive ? 500 : 400,
        }}
        onClick={() => onSelect(workspace)}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {/* Active accent bar */}
        {isActive && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute", left: -1, top: 6, bottom: 6,
              width: 2, background: "var(--vz-sodium)", borderRadius: 2,
            }}
          />
        )}
        {/* Status pip */}
        <span
          aria-hidden="true"
          style={{
            width: 6, height: 6, borderRadius: "50%",
            background: pipColor(workspace),
            flexShrink: 0,
            ...(pipPulse(workspace) ? { animation: "vz-pulse 1.6s ease-in-out infinite" } : {}),
          }}
        />
        {workspace.starred && <Star className="w-3 h-3 shrink-0" style={{ color: "var(--vz-warn)", fill: "var(--vz-warn)" }} />}
        <span className="flex-1 truncate">{name}</span>

        {/* Status word ("stuck" / "failed") OR time — hide when hovering to surface actions */}
        <span
          className="shrink-0 group-hover:hidden"
          style={{
            fontSize: 10.5, fontFamily: "var(--vz-font-mono)",
            color: status === "failed" ? "var(--vz-fail)"
              : status === "stuck" ? "var(--vz-warn)"
              : "var(--vz-muted-2)",
            letterSpacing: "0.04em",
          }}
        >
          {status ?? time}
        </span>

        {/* Actions on hover */}
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUpdate(workspace.session_id, { starred: !workspace.starred }); }}
            className="vz-action-btn"
            style={{ width: 22, height: 22, color: workspace.starred ? "var(--vz-warn)" : "var(--vz-muted-2)" }}
            title={workspace.starred ? "Unstar" : "Star"}
          >
            <Star className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUpdate(workspace.session_id, { archived: !workspace.archived }); }}
            className="vz-action-btn"
            style={{ width: 22, height: 22 }}
            title={workspace.archived ? "Unarchive" : "Archive"}
          >
            <Archive className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(workspace.session_id); }}
            className="vz-action-btn vz-action-btn--danger"
            style={{ width: 22, height: 22 }}
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  function Section({
    id, label, icon: Icon, items, defaultCollapsed = false, group,
  }: {
    id: string;
    label: React.ReactNode;
    icon: React.ElementType;
    items: WorkspaceSummary[];
    defaultCollapsed?: boolean;
    group: "live" | "today" | "earlier";
  }) {
    if (items.length === 0) return null;
    const isOpen = collapsed[id] === undefined ? !defaultCollapsed : !collapsed[id];

    return (
      <div className="mb-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => ({ ...c, [id]: !isOpen }))}
          className="flex items-center gap-1.5 w-full px-3 py-1 text-left"
          style={{
            fontFamily: "var(--vz-font-mono)",
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--vz-muted-2)",
            background: "none",
            border: 0,
          }}
        >
          <ChevronRight
            className={cn("w-3 h-3 transition-transform", isOpen && "rotate-90")}
            style={{ color: "var(--vz-muted-2)" }}
          />
          <Icon className="w-3 h-3" />
          <span>{label}</span>
          <span style={{ marginLeft: "auto", letterSpacing: "0.04em" }}>{items.length}</span>
        </button>
        {isOpen && items.map((w) => (
          <ChatItem key={w.session_id} workspace={w} group={group} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col flex-1 min-h-0", inSheet ? "w-full" : "w-60")}
      style={{
        background: "var(--vz-mute)",
        borderRight: inSheet ? "0" : "1px solid var(--vz-border)",
      }}
    >
      {/* New task CTA */}
      <div className="p-3">
        <button
          type="button"
          onClick={onCreate}
          className="vz-new-task"
        >
          <span className="vz-new-task__plus">
            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          </span>
          <span>New task</span>
          <span className="vz-kbd vz-new-task__kbd">⌘N</span>
        </button>
      </div>

      {/* Time-bucketed list */}
      <div className="flex-1 overflow-y-auto pb-3">
        <Section
          id="live"
          label="Active"
          icon={MessageSquare}
          items={live}
          group="live"
        />
        <Section
          id="today"
          label={<>Today <span style={{ opacity: 0.5 }}>· finished</span></>}
          icon={CheckCircle2}
          items={today}
          group="today"
        />
        <Section
          id="earlier"
          label="Earlier"
          icon={Clock}
          items={earlier}
          group="earlier"
        />
      </div>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete chat?"
        description="This chat will be removed permanently."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => { if (confirmDeleteId) { onDelete(confirmDeleteId); setConfirmDeleteId(null); } }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

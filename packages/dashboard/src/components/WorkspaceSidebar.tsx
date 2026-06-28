import { useMemo, useState } from "react";
import { Plus, ChevronRight, Pin, Archive, Trash2, MessageSquare, CheckCircle2, Clock, ListChecks, CheckSquare, Square, X, Search, PanelLeftClose } from "lucide-react";
import type { GroupedWorkspaces } from "../hooks/useWorkspaces.js";
import type { WorkspaceSummary } from "../api/client.js";
import { Modal, Button } from "@/brand/components.js";
import { cn } from "@/lib/utils.js";

interface Props {
  grouped: GroupedWorkspaces;
  activeId: string | null;
  onSelect: (workspace: WorkspaceSummary) => void;
  onCreate: () => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  /** Collapse the rail (desktop only). Omitted in the mobile Sheet. */
  onCollapse?: () => void;
  inSheet?: boolean;
}

// How many rows a section shows before a "Show more" button appears.
const PAGE_SIZE = 25;

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

export function WorkspaceSidebar({ grouped, activeId, onSelect, onCreate, onUpdate, onDelete, onCollapse, inSheet }: Props) {
  // No section is collapsed by default. The user's complaint on v0.1.79
  // was "can't see past workspaces" — pre-collapsing the section that
  // actually contains them was half the problem (the other half was the
  // time-based isFinished fix below). Sections still auto-hide when
  // empty (see `Section` component), so an open-by-default Earlier won't
  // clutter the sidebar for users without history.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Free-text filter over workspace names. Search spans every bucket.
  const [query, setQuery] = useState("");
  // Per-section "show more" pagination — each section reveals PAGE_SIZE rows at
  // a time so a long history doesn't render hundreds of nodes at once.
  const [shown, setShown] = useState<Record<string, number>>({});
  const showMore = (id: string) => setShown((s) => ({ ...s, [id]: (s[id] ?? PAGE_SIZE) + PAGE_SIZE }));

  // Bulk selection: a "Select" mode turns rows into checkboxes and surfaces a
  // bulk action bar (Delete). Clicking a row toggles its selection instead of
  // navigating. `selected` holds session_ids across all three sections.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };

  const runBulkDelete = () => {
    for (const id of selected) onDelete(id);
    setConfirmBulk(false);
    exitSelect();
  };

  // Re-bucket the four useWorkspaces categories into PINNED / LIVE / TODAY /
  // EARLIER. Pinned workspaces are pulled out first (always-on, top group);
  // the rest split by recency. A name search filters across every bucket.
  const { pinned, live, today, earlier } = useMemo(() => {
    const all: WorkspaceSummary[] = [
      ...grouped.starred,
      ...grouped.active,
      ...grouped.paused,
      ...grouped.archived,
    ];
    const q = query.trim().toLowerCase();
    const matches = (w: WorkspaceSummary) =>
      !q || (w.name ?? w.session_id).toLowerCase().includes(q);
    const dedup = Array.from(new Map(all.map((w) => [w.session_id, w])).values()).filter(matches);
    const sortByActive = (a: WorkspaceSummary, b: WorkspaceSummary) => b.last_active_at.localeCompare(a.last_active_at);
    const rest = dedup.filter((w) => !w.pinned);
    return {
      pinned: dedup.filter((w) => w.pinned).sort(sortByActive),
      live: rest.filter((w) => !isFinished(w)).sort(sortByActive),
      today: rest.filter((w) => isFinished(w) && isToday(w.last_active_at)).sort(sortByActive),
      earlier: rest.filter((w) => isFinished(w) && !isToday(w.last_active_at)).sort(sortByActive),
    };
  }, [grouped, query]);

  const allVisibleIds = useMemo(
    () => [...pinned, ...live, ...today, ...earlier].map((w) => w.session_id),
    [pinned, live, today, earlier],
  );
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(allVisibleIds));

  function ChatItem({ workspace, group, index }: { workspace: WorkspaceSummary; group: "live" | "today" | "earlier"; index: number }) {
    const isActive = workspace.session_id === activeId;
    const isChecked = selected.has(workspace.session_id);
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
          color: isActive && !selectMode ? "var(--vz-ink)" : "var(--vz-ink-3)",
          background: (selectMode ? isChecked : isActive) ? "var(--vz-card)" : "transparent",
          border: (selectMode ? isChecked : isActive) ? "1px solid var(--vz-border)" : "1px solid transparent",
          fontWeight: (selectMode ? isChecked : isActive) ? 500 : 400,
        }}
        onClick={() => (selectMode ? toggleSelected(workspace.session_id) : onSelect(workspace))}
        onMouseEnter={(e) => {
          if (selectMode ? !isChecked : !isActive) (e.currentTarget as HTMLElement).style.background = "var(--vz-mute)";
        }}
        onMouseLeave={(e) => {
          if (selectMode ? !isChecked : !isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {/* Active accent bar */}
        {isActive && !selectMode && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute", left: -1, top: 6, bottom: 6,
              width: 2, background: "var(--vz-sodium)", borderRadius: 2,
            }}
          />
        )}
        {/* Checkbox (select mode) OR status pip */}
        {selectMode ? (
          isChecked
            ? <CheckSquare className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--vz-sodium)" }} />
            : <Square className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--vz-muted-2)" }} />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 6, height: 6, borderRadius: "50%",
              background: pipColor(workspace),
              flexShrink: 0,
              ...(pipPulse(workspace) ? { animation: "vz-pulse 1.6s ease-in-out infinite" } : {}),
            }}
          />
        )}
        {/* Row number */}
        <span
          className="shrink-0 tabular-nums text-right"
          style={{ width: 16, fontSize: 10.5, fontFamily: "var(--vz-font-mono)", color: "var(--vz-muted-2)" }}
        >
          {index}
        </span>
        {workspace.pinned && <Pin className={cn("w-3 h-3 shrink-0", !selectMode && "group-hover:hidden")} style={{ color: "var(--vz-sodium)", fill: "var(--vz-sodium)" }} />}
        <span className="flex-1 truncate">{name}</span>

        {/* Status word ("stuck" / "failed") OR time — hide when hovering to surface actions */}
        {!selectMode && <span
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
        </span>}

        {/* Actions on hover */}
        {!selectMode && <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUpdate(workspace.session_id, { pinned: !workspace.pinned }); }}
            className="vz-action-btn"
            style={{ width: 22, height: 22, color: workspace.pinned ? "var(--vz-sodium)" : "var(--vz-muted-2)" }}
            title={workspace.pinned ? "Unpin (allow idle)" : "Pin (keep always-on)"}
          >
            <Pin className="w-3 h-3" />
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
        </div>}
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
    const limit = shown[id] ?? PAGE_SIZE;
    const visibleItems = items.slice(0, limit);
    const remaining = items.length - visibleItems.length;

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
        {isOpen && visibleItems.map((w, i) => (
          <ChatItem key={w.session_id} workspace={w} group={group} index={i + 1} />
        ))}
        {isOpen && remaining > 0 && (
          <button
            type="button"
            onClick={() => showMore(id)}
            className="w-full text-left px-3 py-1 mx-1.5 text-[11px]"
            style={{ color: "var(--vz-sodium)", background: "none", border: 0, cursor: "pointer" }}
          >
            Show {Math.min(remaining, PAGE_SIZE)} more{remaining > PAGE_SIZE ? ` (${remaining} left)` : ""}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col flex-1 min-h-0 w-full")}
      style={{
        background: "var(--vz-mute)",
        borderRight: inSheet ? "0" : "1px solid var(--vz-border)",
      }}
    >
      {/* New task CTA */}
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCreate}
            className="vz-new-task flex-1"
          >
            <span className="vz-new-task__plus">
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
            </span>
            <span>New task</span>
            <span className="vz-kbd vz-new-task__kbd">⌘K</span>
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="vz-action-btn shrink-0"
              title="Collapse list"
              aria-label="Collapse workspace list"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative mt-2">
          <Search
            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--vz-muted-2)" }}
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full text-[12px] rounded-md outline-none"
            style={{
              padding: "5px 24px 5px 28px",
              background: "var(--vz-card)",
              border: "1px solid var(--vz-border)",
              color: "var(--vz-ink)",
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--vz-muted-2)", background: "none", border: 0, cursor: "pointer" }}
              title="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Select / bulk-actions toggle */}
        <div className={cn("flex items-center mt-2 px-0.5", selectMode ? "justify-between" : "justify-end")}>
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="inline-flex items-center gap-1 text-[11px]"
                style={{ color: "var(--vz-muted-2)", background: "none", border: 0 }}
              >
                {allSelected
                  ? <><Square className="w-3 h-3" /> Clear all</>
                  : <><CheckSquare className="w-3 h-3" /> Check all</>}
              </button>
              <button
                type="button"
                onClick={exitSelect}
                className="inline-flex items-center gap-1 text-[11px]"
                style={{ color: "var(--vz-muted-2)", background: "none", border: 0 }}
              >
                <X className="w-3 h-3" /> Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="inline-flex items-center gap-1 text-[11px]"
              style={{ color: "var(--vz-muted-2)", background: "none", border: 0 }}
              title="Select multiple"
            >
              <ListChecks className="w-3 h-3" /> Select
            </button>
          )}
        </div>
      </div>

      {/* Time-bucketed list */}
      <div className="flex-1 overflow-y-auto pb-3">
        <Section
          id="pinned"
          label="Pinned"
          icon={Pin}
          items={pinned}
          group="live"
        />
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

      {/* Bulk action bar */}
      {selectMode && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: "1px solid var(--vz-border)", background: "var(--vz-card)" }}
        >
          <span className="text-[12px]" style={{ color: "var(--vz-ink-3)" }}>
            {selected.size} selected
          </span>
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={selected.size === 0}
            onClick={() => setConfirmBulk(true)}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Delete
          </Button>
        </div>
      )}

      <Modal
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={`Delete ${selected.size} chat${selected.size === 1 ? "" : "s"}?`}
        description="These chats will be removed permanently."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmBulk(false)}>Cancel</Button>
            <Button variant="danger" size="sm" autoFocus onClick={runBulkDelete}>
              Delete {selected.size}
              <span
                className="vz-kbd"
                style={{ marginLeft: 6, background: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.85)" }}
              >
                Enter ⏎
              </span>
            </Button>
          </>
        }
      />

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete chat?"
        description="This chat will be removed permanently."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            {/* autoFocus: the Modal mounts fresh on open, so focus lands here
                and a plain Enter confirms (native button activation). */}
            <Button
              variant="danger"
              size="sm"
              autoFocus
              onClick={() => { if (confirmDeleteId) { onDelete(confirmDeleteId); setConfirmDeleteId(null); } }}
            >
              Delete
              <span
                className="vz-kbd"
                style={{ marginLeft: 6, background: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.85)" }}
              >
                Enter ⏎
              </span>
            </Button>
          </>
        }
      />
    </div>
  );
}

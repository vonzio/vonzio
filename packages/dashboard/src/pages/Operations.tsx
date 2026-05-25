import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  Activity, Box, Cpu, Wifi, Clock, Trash2, XCircle, RefreshCw,
  Pause, Play, Server, Eye,
} from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import {
  fetchHealth, fetchContainers, fetchTasks, fetchWorkspaces, fetchPoolStatus,
  fetchWorkspaceEvents, removeContainer, cancelTask, deleteWorkspace,
  type HealthStatus, type ContainerInfo, type TaskSummary, type WorkspaceSummary,
  type PoolStatus, type SessionEvent,
} from "../api/client.js";
import {
  PageHeader,
  PageBody,
  Tabs,
  Card,
  Button,
  Modal,
  Pill,
  StatCard,
  DataTable,
  EmptyState,
  ChipRow,
  type DataColumn,
  type ChipDef,
} from "../brand/components.js";

// ─── Helpers ────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(id: string | null): string {
  if (!id) return "—";
  if (id.length <= 12) return id;
  return id.slice(0, 12);
}

const statusTone: Record<string, "ok" | "info" | "warn" | "fail" | undefined> = {
  running: "ok", active: "ok", idle: "info", paused: "warn",
  resumable: "warn", queued: "info", completed: undefined, failed: "fail",
  cancelled: undefined, expired: undefined, exited: undefined, created: "info",
};

const PAGE_SIZE = 25;

function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number) {
  const result = useApi<T>(fetcher);
  useEffect(() => {
    const id = setInterval(() => result.refetch(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, result.refetch]);
  return result;
}

// ─── Default export: full page (used at /ops) ──────────────────────────
export function Operations() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Platform health"
        lede="Containers, sessions, and tasks — live, polling every 5–10s."
      />
      <PageBody>
        <OperationsContent />
      </PageBody>
    </>
  );
}

// ─── Content-only inner component (re-embedded by Admin's tab) ─────────

type OpsTab = "sessions" | "tasks" | "containers";

export function OperationsContent() {
  const validTabs: OpsTab[] = ["sessions", "tasks", "containers"];
  const hashTab = window.location.hash.slice(1) as OpsTab;
  const [tab, setTabRaw] = useState<OpsTab>(validTabs.includes(hashTab) ? hashTab : "sessions");

  const setTab = useCallback((id: string) => {
    setTabRaw(id as OpsTab);
    window.location.hash = id;
  }, []);

  useEffect(() => {
    const handler = () => {
      const h = window.location.hash.slice(1) as OpsTab;
      if (validTabs.includes(h)) setTabRaw(h);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const [sessionPage, setSessionPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [sessionFilter, setSessionFilter] = useState<string>("");
  const [taskFilter, setTaskFilter] = useState<string>("");
  const [selectedSession, setSelectedSession] = useState<WorkspaceSummary | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskSummary | null>(null);

  const health = usePolling<HealthStatus>(() => fetchHealth(), 5000);
  const pool = usePolling<PoolStatus>(() => fetchPoolStatus(), 5000);
  const containers = usePolling<{ containers: ContainerInfo[] }>(() => fetchContainers(), 10000);
  const sessions = usePolling<{ workspaces: WorkspaceSummary[]; total: number }>(() => fetchWorkspaces(), 10000);
  const tasks = usePolling<{ tasks: TaskSummary[]; total: number }>(() => fetchTasks({ limit: 500 }), 10000);

  const [error, setError] = useState("");

  const handleRemoveContainer = async (id: string) => {
    if (!window.confirm("Remove this container?")) return;
    try { await removeContainer(id); containers.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };
  const handleCancelTask = async (id: string) => {
    if (!window.confirm("Cancel this task?")) return;
    try { await cancelTask(id); tasks.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };
  const handleTerminateSession = async (id: string) => {
    if (!window.confirm("Terminate this session and destroy its container?")) return;
    try { await deleteWorkspace(id); sessions.refetch(); containers.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const refreshAll = () => {
    containers.refetch(); sessions.refetch(); tasks.refetch(); health.refetch(); pool.refetch();
  };

  const allSessions = sessions.data?.workspaces ?? [];
  const filteredSessions = sessionFilter ? allSessions.filter((s) => s.status === sessionFilter) : allSessions;

  const allTasks = tasks.data?.tasks ?? [];
  const filteredTasks = taskFilter ? allTasks.filter((t) => t.status === taskFilter) : allTasks;

  const activeSessions = allSessions.filter((s) => s.status === "active" || s.status === "idle").length;
  const pausedSessions = allSessions.filter((s) => s.status === "paused").length;
  const resumableSessions = allSessions.filter((s) => s.status === "resumable").length;
  const runningTasks = allTasks.filter((t) => t.status === "running").length;
  const queuedTasks = allTasks.filter((t) => t.status === "queued").length;

  const sessionStatuses = [...new Set(allSessions.map((s) => s.status))].sort();
  const taskStatuses = [...new Set(allTasks.map((t) => t.status))].sort();

  const tabDefs = [
    { value: "sessions", label: `Sessions (${allSessions.length})` },
    { value: "tasks", label: `Tasks (${allTasks.length})` },
    { value: "containers", label: `Containers (${containers.data?.containers.length ?? 0})` },
  ];

  const sessionChips: ChipDef[] = [
    { value: "", label: "All", count: allSessions.length },
    ...sessionStatuses.map((s) => ({ value: s, label: s, count: allSessions.filter((ws) => ws.status === s).length })),
  ];
  const taskChips: ChipDef[] = [
    { value: "", label: "All", count: allTasks.length },
    ...taskStatuses.map((s) => ({ value: s, label: s, count: allTasks.filter((t) => t.status === s).length })),
  ];

  // ─── Column defs ──────────────────────────────────────────────────────

  const sessionCols: DataColumn<WorkspaceSummary>[] = [
    {
      key: "session_id",
      label: "Session",
      render: (s) => <code style={{ fontSize: 11, color: "var(--vz-ink-3)" }}>{s.session_id}</code>,
    },
    {
      key: "name",
      label: "Name",
      render: (s) => (
        <span style={{ fontSize: 13, color: "var(--vz-ink-3)", maxWidth: 160, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {s.name ?? "—"}
        </span>
      ),
    },
    { key: "status", label: "Status", render: (s) => <Pill tone={statusTone[s.status]}>{s.status}</Pill> },
    {
      key: "container",
      label: "Container",
      render: (s) => s.container_id
        ? <code style={{ fontSize: 11, color: "var(--vz-muted)" }}>{shortId(s.container_id)}</code>
        : <span style={{ color: "var(--vz-muted-2)" }}>—</span>,
    },
    {
      key: "last_active",
      label: "Last active",
      render: (s) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatRelative(s.last_active_at)}</span>,
    },
    {
      key: "ttl",
      label: "TTL",
      render: (s) => <span style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>{formatTimeLeft(s.expires_at)}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "80px",
      align: "right",
      render: (s) => (
        <div style={{ display: "inline-flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="vz-action-btn" title="View details" onClick={() => setSelectedSession(s)}>
            <Eye size={14} />
          </button>
          {(s.status === "active" || s.status === "idle" || s.status === "paused" || s.status === "resumable") && (
            <button
              type="button"
              className="vz-action-btn vz-action-btn--danger"
              title="Terminate"
              onClick={() => handleTerminateSession(s.session_id)}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const taskCols: DataColumn<TaskSummary>[] = [
    {
      key: "id",
      label: "Task",
      render: (t) => <code style={{ fontSize: 11, color: "var(--vz-ink-3)" }}>{t.id}</code>,
    },
    { key: "status", label: "Status", render: (t) => <Pill tone={statusTone[t.status]}>{t.status}</Pill> },
    { key: "mode", label: "Mode", render: (t) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{t.mode}</span> },
    {
      key: "prompt",
      label: "Prompt",
      render: (t) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)", maxWidth: 220, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.prompt.slice(0, 60)}{t.prompt.length > 60 ? "…" : ""}
        </span>
      ),
    },
    {
      key: "session",
      label: "Session",
      render: (t) => t.session_id
        ? <code style={{ fontSize: 11, color: "var(--vz-muted)" }}>{shortId(t.session_id)}</code>
        : <span style={{ color: "var(--vz-muted-2)" }}>—</span>,
    },
    {
      key: "created",
      label: "Created",
      render: (t) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatRelative(t.created_at)}</span>,
    },
    {
      key: "duration",
      label: "Duration",
      numeric: true,
      render: (t) => {
        const d = t.started_at && t.finished_at
          ? `${Math.round((new Date(t.finished_at).getTime() - new Date(t.started_at).getTime()) / 1000)}s`
          : t.started_at ? "running…" : "—";
        return <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{d}</span>;
      },
    },
    {
      key: "_actions",
      label: "",
      width: "80px",
      align: "right",
      render: (t) => (
        <div style={{ display: "inline-flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="vz-action-btn" title="View details" onClick={() => setSelectedTask(t)}>
            <Eye size={14} />
          </button>
          {(t.status === "queued" || t.status === "running") && (
            <button type="button" className="vz-action-btn vz-action-btn--danger" title="Cancel" onClick={() => handleCancelTask(t.id)}>
              <XCircle size={14} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const containerCols: DataColumn<ContainerInfo>[] = [
    {
      key: "id",
      label: "Container",
      render: (c) => <code style={{ fontSize: 11, color: "var(--vz-ink-3)" }}>{shortId(c.id)}</code>,
    },
    { key: "status", label: "Status", render: (c) => <Pill tone={statusTone[c.status]}>{c.status}</Pill> },
    {
      key: "assignment",
      label: "Assignment",
      render: (c) => (
        <Pill tone={
          c.assignment === "session" ? "ok"
            : c.assignment === "pool-idle" ? "info"
              : c.assignment === "pool-busy" ? "warn"
                : undefined
        }>
          {c.assignment}
        </Pill>
      ),
    },
    {
      key: "session",
      label: "Session",
      render: (c) => c.session_id
        ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const s = allSessions.find((ws) => ws.session_id === c.session_id);
              if (s) setSelectedSession(s);
            }}
            style={{ background: "none", border: 0, padding: 0, fontFamily: "var(--vz-font-mono)", fontSize: 11, color: "var(--vz-sodium)", cursor: "pointer" }}
          >
            {c.session_id}
          </button>
        )
        : <span style={{ color: "var(--vz-muted-2)" }}>—</span>,
    },
    {
      key: "created",
      label: "Created",
      render: (c) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatRelative(c.created_at)}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "60px",
      align: "right",
      render: (c) => (
        <button
          type="button"
          className="vz-action-btn vz-action-btn--danger"
          title="Remove"
          onClick={(e) => { e.stopPropagation(); handleRemoveContainer(c.id); }}
        >
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {error && (
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            fontSize: 13, color: "var(--vz-fail)",
            background: "rgba(220, 38, 38, 0.08)",
            border: "1px solid rgba(220, 38, 38, 0.25)",
            padding: "10px 12px",
            borderRadius: "var(--vz-radius-md)",
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss" style={{ background: "none", border: 0, cursor: "pointer", color: "var(--vz-fail)", padding: 4, display: "flex" }}>
            <XCircle size={14} />
          </button>
        </div>
      )}

      {/* Stat row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCard
          label="Pool (idle / busy)"
          value={pool.data ? `${pool.data.idle} / ${pool.data.busy}` : "—"}
          icon={<Box size={16} />}
          mono
        />
        <StatCard label="Active sessions" value={activeSessions} icon={<Cpu size={16} />} />
        <StatCard
          label="Paused / resumable"
          value={`${pausedSessions} / ${resumableSessions}`}
          icon={<Pause size={16} />}
          mono
        />
        <StatCard label="Connections" value={health.data?.connections ?? "—"} icon={<Wifi size={16} />} />
      </div>

      {/* Stat row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCard label="Running tasks" value={runningTasks} icon={<Activity size={16} />} />
        <StatCard label="Queued" value={queuedTasks} icon={<Clock size={16} />} />
        <StatCard label="Containers" value={containers.data?.containers.length ?? "—"} icon={<Server size={16} />} />
        <StatCard label="Total sessions" value={sessions.data?.total ?? "—"} icon={<Play size={16} />} />
      </div>

      {/* Tabs row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <Tabs tabs={tabDefs} value={tab} onChange={setTab} />
        </div>
        <button
          type="button"
          onClick={refreshAll}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 10px",
            background: "none",
            border: "1px solid var(--vz-border)",
            borderRadius: "var(--vz-radius-md)",
            color: "var(--vz-muted)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--vz-font-mono)",
            letterSpacing: "0.04em",
          }}
        >
          <RefreshCw size={12} /> refresh
        </button>
      </div>

      {/* Sessions */}
      {tab === "sessions" && (
        <>
          <ChipRow chips={sessionChips} value={sessionFilter} onChange={(v) => { setSessionFilter(v); setSessionPage(0); }} />
          <DataTable
            title="Sessions"
            count={filteredSessions.length}
            columns={sessionCols}
            rows={filteredSessions}
            rowKey={(s) => s.session_id}
            onRowClick={(s) => setSelectedSession(s)}
            loading={sessions.loading}
            page={sessionPage}
            pageSize={PAGE_SIZE}
            total={filteredSessions.length}
            onPageChange={setSessionPage}
            emptyState={<EmptyState icon={<Cpu size={20} />} title="No sessions" />}
          />
        </>
      )}

      {/* Tasks */}
      {tab === "tasks" && (
        <>
          <ChipRow chips={taskChips} value={taskFilter} onChange={(v) => { setTaskFilter(v); setTaskPage(0); }} />
          <DataTable
            title="Tasks"
            count={filteredTasks.length}
            columns={taskCols}
            rows={filteredTasks}
            rowKey={(t) => t.id}
            onRowClick={(t) => setSelectedTask(t)}
            loading={tasks.loading}
            page={taskPage}
            pageSize={PAGE_SIZE}
            total={filteredTasks.length}
            onPageChange={setTaskPage}
            emptyState={<EmptyState icon={<Activity size={20} />} title="No tasks" />}
          />
        </>
      )}

      {/* Containers */}
      {tab === "containers" && (
        <DataTable
          title="Containers"
          count={containers.data?.containers.length}
          columns={containerCols}
          rows={containers.data?.containers ?? []}
          rowKey={(c) => c.id}
          loading={containers.loading}
          emptyState={<EmptyState icon={<Server size={20} />} title="No containers" />}
        />
      )}

      {/* Detail modals */}
      {selectedSession && <SessionModal session={selectedSession} onClose={() => setSelectedSession(null)} />}
      {selectedTask && <TaskModal task={selectedTask} onClose={() => setSelectedTask(null)} />}
    </div>
  );
}

// ─── Session detail modal ──────────────────────────────────────────────

function SessionModal({ session, onClose }: { session: WorkspaceSummary; onClose: () => void }) {
  const { data: events, loading } = useApi<SessionEvent[]>(
    () => fetchWorkspaceEvents(session.session_id),
    [session.session_id],
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={session.name ?? session.session_id}
      description={
        <span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11.5 }}>
          {session.session_id}
        </span>
      }
      footer={
        <>
          <span style={{ flex: 1, fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
            {events?.length ?? 0} events
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: "4px 14px", fontSize: 12, marginBottom: 16, fontFamily: "var(--vz-font-mono)", color: "var(--vz-ink-3)" }}>
        <Meta>Status</Meta>
        <span><Pill tone={statusTone[session.status]}>{session.status}</Pill></span>
        <Meta>Container</Meta>
        <span>{shortId(session.container_id)}</span>
        <Meta>Profile</Meta>
        <span>{session.profile_id}</span>
        <Meta>Created</Meta>
        <span>{new Date(session.created_at).toLocaleString()}</span>
        <Meta>Last active</Meta>
        <span>{formatRelative(session.last_active_at)}</span>
        <Meta>TTL</Meta>
        <span>{formatTimeLeft(session.expires_at)}</span>
      </div>

      <div style={{ borderTop: "1px solid var(--vz-border)", paddingTop: 14, marginTop: 4 }}>
        <SubLabel>Conversation log</SubLabel>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)", padding: "16px 0" }}>loading…</div>
        ) : !events?.length ? (
          <div style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", padding: "16px 0" }}>no events recorded</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "55vh", overflowY: "auto" }}>
            {events.map((evt) => <EventEntry key={evt.seq} event={evt} />)}
          </div>
        )}
      </div>
    </Modal>
  );
}

function EventEntry({ event }: { event: SessionEvent }) {
  const time = formatTimestamp(event.ts);
  const tsCol = (
    <span style={{ fontSize: 10.5, color: "var(--vz-muted-2)", width: 60, flexShrink: 0, fontFamily: "var(--vz-font-mono)", paddingTop: 2 }}>
      {time}
    </span>
  );

  switch (event.type) {
    case "user_message":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {tsCol}
          <div style={{
            flex: 1, fontSize: 13,
            background: "var(--vz-sodium-08)",
            border: "1px solid var(--vz-sodium-25)",
            borderRadius: "var(--vz-radius-md)",
            padding: "8px 12px",
            color: "var(--vz-ink)",
          }}>
            {event.data.text as string}
          </div>
        </div>
      );
    case "text": {
      const text = event.data.text as string;
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {tsCol}
          <div style={{
            flex: 1, fontSize: 13,
            background: "var(--vz-mute)",
            border: "1px solid var(--vz-border)",
            borderRadius: "var(--vz-radius-md)",
            padding: "8px 12px",
            color: "var(--vz-ink-3)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}>
            {text.slice(0, 2000)}
            {text.length > 2000 && <span style={{ color: "var(--vz-muted-2)" }}> …truncated</span>}
          </div>
        </div>
      );
    }
    case "tool_use": {
      const input = event.data.input;
      const hasInput = Boolean(input && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0);
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {tsCol}
          <div style={{ flex: 1, fontSize: 12 }}>
            <Pill tone="info">{event.data.tool as string}</Pill>
            {hasInput && (
              <pre style={{
                marginTop: 4,
                background: "var(--vz-mute)",
                border: "1px solid var(--vz-border)",
                borderRadius: "var(--vz-radius-sm)",
                padding: 6,
                fontSize: 10.5,
                fontFamily: "var(--vz-font-mono)",
                color: "var(--vz-muted)",
                overflowX: "auto",
                maxHeight: 96,
              }}>
                {JSON.stringify(input, null, 2).slice(0, 500)}
              </pre>
            )}
          </div>
        </div>
      );
    }
    case "tool_result":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {tsCol}
          <div style={{ flex: 1, fontSize: 12 }}>
            <span style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>result · {event.data.tool as string}</span>
            <pre style={{
              marginTop: 4,
              background: "rgba(22, 163, 74, 0.06)",
              border: "1px solid rgba(22, 163, 74, 0.2)",
              borderRadius: "var(--vz-radius-sm)",
              padding: 6,
              fontSize: 10.5,
              fontFamily: "var(--vz-font-mono)",
              color: "var(--vz-muted)",
              overflowX: "auto",
              maxHeight: 96,
            }}>
              {((event.data.output as string) ?? "").slice(0, 500)}
            </pre>
          </div>
        </div>
      );
    case "turn.done":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {tsCol}
          <div style={{ flex: 1, borderTop: "1px dashed var(--vz-border)" }} />
          <span style={{ fontSize: 10.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>turn complete</span>
        </div>
      );
    default:
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {tsCol}
          <div style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>{event.type}</div>
        </div>
      );
  }
}

// ─── Task detail modal ────────────────────────────────────────────────

function TaskModal({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  type ResultShape = { text?: string; input_tokens?: number; output_tokens?: number; cost_usd?: number };
  const result = task.result as unknown as ResultShape | undefined;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Task ${task.id}`}
      description={<span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11.5 }}>{task.id}</span>}
      footer={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: "4px 14px", fontSize: 12, marginBottom: 16, fontFamily: "var(--vz-font-mono)", color: "var(--vz-ink-3)" }}>
        <Meta>Status</Meta>
        <span><Pill tone={statusTone[task.status]}>{task.status}</Pill></span>
        <Meta>Mode</Meta>
        <span>{task.mode}</span>
        <Meta>Profile</Meta>
        <span>{task.profile_id}</span>
        <Meta>Session</Meta>
        <span>{task.session_id ?? "—"}</span>
        <Meta>Attempt</Meta>
        <span>{task.attempt}</span>
        <Meta>Created</Meta>
        <span>{new Date(task.created_at).toLocaleString()}</span>
        {task.started_at && (<>
          <Meta>Started</Meta>
          <span>{new Date(task.started_at).toLocaleString()}</span>
        </>)}
        {task.finished_at && (<>
          <Meta>Finished</Meta>
          <span>{new Date(task.finished_at).toLocaleString()}</span>
        </>)}
      </div>

      <div style={{ borderTop: "1px solid var(--vz-border)", paddingTop: 14 }}>
        <SubLabel>Prompt</SubLabel>
        <pre style={{
          background: "var(--vz-sodium-08)",
          border: "1px solid var(--vz-sodium-25)",
          borderRadius: "var(--vz-radius-md)",
          padding: 12,
          fontSize: 13,
          color: "var(--vz-ink)",
          whiteSpace: "pre-wrap",
          margin: 0,
          fontFamily: "inherit",
        }}>
          {task.prompt}
        </pre>
      </div>

      {result && (
        <div style={{ marginTop: 16 }}>
          <SubLabel>Result</SubLabel>
          <pre style={{
            background: "var(--vz-mute)",
            border: "1px solid var(--vz-border)",
            borderRadius: "var(--vz-radius-md)",
            padding: 12,
            fontSize: 13,
            color: "var(--vz-ink-3)",
            whiteSpace: "pre-wrap",
            margin: 0,
            fontFamily: "inherit",
          }}>
            {result.text ?? "—"}
          </pre>
          <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", display: "flex", gap: 16 }}>
            <span>input: {result.input_tokens ?? 0}</span>
            <span>output: {result.output_tokens ?? 0}</span>
            <span>cost: ${(result.cost_usd ?? 0).toFixed(4)}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── tiny local helpers ───────────────────────────────────────────────
function Meta({ children }: { children: ReactNode }) {
  return <span style={{ color: "var(--vz-muted-2)" }}>{children}</span>;
}
function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--vz-font-mono)",
      fontSize: 11,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color: "var(--vz-muted-2)",
      marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

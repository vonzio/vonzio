import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from "react";
import {
  Users as UsersIcon,
  ShieldCheck,
  Ban,
  Trash2 as TrashIcon,
  UserPlus,
  Activity,
} from "lucide-react";
import {
  fetchInvites,
  createInvite,
  revokeInvite,
  updateUserFlags,
  fetchAdminEvents,
  fetchEventFunnel,
  type InviteInfo,
  type EventRow,
  type EventFilters,
  type FunnelStep,
} from "../api/admin.js";
import {
  PageHeader,
  PageBody,
  Tabs,
  Card,
  Button,
  Field,
  Input,
  Select,
  Toggle,
  Pill,
  Badge,
  DataTable,
  Modal,
  EmptyState,
  type DataColumn,
  type SelectOption,
} from "../brand/components.js";
import { formatDate, hasFlag, toggleFlag } from "../lib/utils.js";
import { authClient } from "../lib/auth-client.js";
import { useUser } from "../contexts/UserContext.js";

interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  banReason?: string;
  createdAt: string;
  featureFlags?: string;
}

const adminTabs = [
  { value: "users", label: "Users" },
  { value: "events", label: "Events" },
];

export function Admin() {
  const validIds = adminTabs.map((t) => t.value);
  const hashTab = window.location.hash.slice(1);
  const [activeTab, setActiveTabRaw] = useState(validIds.includes(hashTab) ? hashTab : "users");

  const setActiveTab = useCallback((id: string) => {
    setActiveTabRaw(id);
    window.location.hash = id;
  }, []);

  useEffect(() => {
    const handler = () => {
      const h = window.location.hash.slice(1);
      if (validIds.includes(h)) setActiveTabRaw(h);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Operator console"
        lede="Platform health, user management, and beta-funnel observability."
      />
      <PageBody>
        <Tabs tabs={adminTabs} value={activeTab} onChange={setActiveTab} />
        <div style={{ marginTop: 24 }}>
          {activeTab === "users" && <UsersTab />}
          {activeTab === "events" && <EventsTab />}
        </div>
      </PageBody>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Events tab
// ───────────────────────────────────────────────────────────────────

function EventsTab() {
  const [filters, setFilters] = useState<EventFilters>({ limit: 500 });
  const [events, setEvents] = useState<EventRow[]>([]);
  const [funnel, setFunnel] = useState<{ since: string; steps: FunnelStep[] } | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; email: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  // Reset to first page whenever filter inputs change.
  useEffect(() => { setPage(0); }, [filters.user_id, filters.event, filters.source, filters.since]);
  const visibleEvents = useMemo(
    () => events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [events, page],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rows, fn] = await Promise.all([fetchAdminEvents(filters), fetchEventFunnel()]);
      setEvents(rows.events);
      setFunnel(fn);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load events");
    }
    setLoading(false);
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await authClient.admin.listUsers({ query: { limit: 100 } });
        const list = (res.data?.users ?? []).map((u) => ({ id: u.id, email: u.email, name: u.name ?? "" }));
        list.sort((a, b) => a.email.localeCompare(b.email));
        setUsers(list);
      } catch { /* noop */ }
    })();
  }, []);

  const topStep = funnel?.steps[0]?.users ?? 0;

  const userOptions: SelectOption[] = [
    { value: "", label: "All users" },
    ...users.map((u) => ({ value: u.id, label: u.email })),
  ];

  const sourceOptions: SelectOption[] = [
    { value: "", label: "Any" },
    { value: "server", label: "Server" },
    { value: "client", label: "Client" },
  ];

  const eventCols: DataColumn<EventRow>[] = [
    {
      key: "time",
      label: "Time",
      width: "180px",
      render: (r) => <span style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>{formatDate(r.created_at)}</span>,
    },
    {
      key: "event",
      label: "Event",
      render: (r) => <span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 12.5, color: "var(--vz-ink)" }}>{r.event}</span>,
    },
    {
      key: "source",
      label: "Source",
      width: "100px",
      render: (r) => <Badge>{r.source}</Badge>,
    },
    {
      key: "user",
      label: "User",
      render: (r) =>
        r.user_email ? (
          <div>
            <div style={{ fontSize: 12.5, color: "var(--vz-ink-3)" }}>{r.user_email}</div>
            <div style={{ fontSize: 10.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }} title={r.user_id ?? ""}>
              {r.user_id ? r.user_id.slice(0, 10) + "…" : ""}
            </div>
          </div>
        ) : (
          <span style={{ color: "var(--vz-muted-2)" }}>—</span>
        ),
    },
    {
      key: "props",
      label: "Props",
      width: "260px",
      render: (r) =>
        r.properties ? (
          <div onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              style={{
                fontSize: 11,
                fontFamily: "var(--vz-font-mono)",
                color: "var(--vz-sodium)",
                background: "none",
                border: 0,
                padding: 0,
                cursor: "pointer",
                letterSpacing: "0.04em",
              }}
            >
              {expanded === r.id ? "[ hide ]" : "[ show ]"}
            </button>
            {expanded === r.id && (
              <pre
                style={{
                  fontSize: 11,
                  fontFamily: "var(--vz-font-mono)",
                  background: "var(--vz-mute)",
                  border: "1px solid var(--vz-border)",
                  padding: 8,
                  marginTop: 6,
                  borderRadius: "var(--vz-radius-sm)",
                  overflowX: "auto",
                  color: "var(--vz-ink-3)",
                  maxHeight: 200,
                }}
              >
                {JSON.stringify(r.properties, null, 2)}
              </pre>
            )}
          </div>
        ) : (
          <span style={{ color: "var(--vz-muted-2)" }}>—</span>
        ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: "var(--vz-ink)", margin: 0 }}>Beta funnel</h3>
          <span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11, color: "var(--vz-muted-2)" }}>last 30 days</span>
        </div>
        {funnel ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {funnel.steps.map((s) => {
              const pct = topStep > 0 ? Math.round((s.users / topStep) * 100) : 0;
              return (
                <div
                  key={s.key}
                  style={{
                    background: "var(--vz-mute)",
                    border: "1px solid var(--vz-border)",
                    borderRadius: "var(--vz-radius-md)",
                    padding: 12,
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em" }}>{s.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 600, color: "var(--vz-ink)", letterSpacing: "-0.01em", marginTop: 4 }}>{s.users}</div>
                  {s.key !== "user.signed_up" && topStep > 0 && (
                    <div style={{ fontSize: 11, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", marginTop: 2 }}>{pct}% of signed up</div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>loading…</div>
        )}
      </Card>

      <div
        style={{
          display: "grid",
          // Auto-fit: 4 columns on wide, collapses to 2 then 1 on narrow.
          // Refresh button drops to its own row when filters wrap.
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          alignItems: "end",
        }}
      >
        <Field label="User">
          <Select
            value={filters.user_id ?? ""}
            onChange={(v) => setFilters((f) => ({ ...f, user_id: v || undefined }))}
            options={userOptions}
            placeholder="All users"
          />
        </Field>
        <Field label="Event prefix" hint="e.g. user. or playbook.">
          <Input
            value={filters.event ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, event: e.target.value || undefined }))}
            placeholder="user."
          />
        </Field>
        <Field label="Source">
          <Select
            value={filters.source ?? ""}
            onChange={(v) => setFilters((f) => ({ ...f, source: (v || undefined) as "server" | "client" | undefined }))}
            options={sourceOptions}
          />
        </Field>
        <Field label="Since (ISO)">
          <Input
            value={filters.since ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value || undefined }))}
            placeholder="2026-04-01"
          />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button size="sm" onClick={() => void load()}>Refresh</Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            fontSize: 13,
            color: "var(--vz-fail)",
            background: "rgba(220, 38, 38, 0.08)",
            border: "1px solid rgba(220, 38, 38, 0.25)",
            padding: "10px 12px",
            borderRadius: "var(--vz-radius-md)",
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          {error}
        </div>
      )}

      <DataTable
        title="Events"
        count={events.length}
        columns={eventCols}
        rows={visibleEvents}
        rowKey={(r) => String(r.id)}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={events.length}
        onPageChange={setPage}
        emptyState={
          <EmptyState
            icon={<Activity size={20} />}
            title="No events"
            description="No events match the current filters. Try widening the time range or clearing the prefix."
          />
        }
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Users tab
// ───────────────────────────────────────────────────────────────────

function UsersTab() {
  const currentUser = useUser();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [inviteResult, setInviteResult] = useState<{ email: string; token?: string } | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("user");

  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);
  const selectedUserRef = useRef(selectedUser);
  selectedUserRef.current = selectedUser;

  const ollamaGlobal = (window as { __VONZIO_OLLAMA_ENABLED?: boolean }).__VONZIO_OLLAMA_ENABLED;

  const loadInvites = async () => {
    try { const data = await fetchInvites(); setInvites(data); } catch { /* noop */ }
  };

  const fetchUsers = async () => {
    try {
      const res = await authClient.admin.listUsers({ query: { limit: 100 } });
      if (res.data) {
        const fresh = ((res.data.users ?? []) as unknown as Array<Record<string, unknown>>).map((u) => ({
          ...u,
          featureFlags: (u.featureFlags ?? u.feature_flags ?? "") as string,
        })) as unknown as UserInfo[];
        setUsers(fresh);
        if (selectedUserRef.current) {
          const updated = fresh.find((u) => u.id === selectedUserRef.current!.id);
          if (updated) setSelectedUser(updated);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); loadInvites(); }, []);

  const handleInvite = async () => {
    if (!inviteEmail) return;
    setError("");
    try {
      const result = await createInvite({ email: inviteEmail, role: inviteRole });
      setInviteResult({ email: inviteEmail, token: result.token });
      setInviteEmail(""); setInviteRole("user"); setShowInvite(false);
      loadInvites();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to send invite"); }
  };

  const handleRevokeInvite = async (id: string) => {
    try { await revokeInvite(id); loadInvites(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  type ConfirmAction = {
    title: string;
    message: string;
    label: string;
    variant: "danger" | "primary";
    action: () => Promise<void>;
  };
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const handleSetRole = (userId: string, role: "user" | "admin") => {
    const userName = users.find((u) => u.id === userId)?.name ?? "this user";
    setConfirmAction({
      title: `Change role to ${role}?`,
      message: `${userName} will ${role === "admin" ? "gain full admin access to all settings, users, and data" : "lose admin access"}.`,
      variant: role === "admin" ? "danger" : "primary",
      label: `Set as ${role}`,
      action: async () => {
        setError("");
        try {
          await authClient.admin.setRole({ userId, role });
          fetchUsers();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to update role");
        }
        setConfirmAction(null);
      },
    });
  };

  const handleToggleFlag = async (userId: string, flag: string, current: string) => {
    try {
      await updateUserFlags(userId, toggleFlag(current, flag));
      fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update flags");
    }
  };

  const handleBan = (userId: string) => {
    const userName = users.find((u) => u.id === userId)?.name ?? "this user";
    setConfirmAction({
      title: "Ban user?",
      message: `${userName} will be unable to log in. You can unban them later.`,
      variant: "danger",
      label: "Ban User",
      action: async () => {
        setError("");
        try {
          await authClient.admin.banUser({ userId });
          fetchUsers();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to ban user");
        }
        setConfirmAction(null);
      },
    });
  };

  const handleUnban = async (userId: string) => {
    setError("");
    try {
      await authClient.admin.unbanUser({ userId });
      fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unban user");
    }
  };

  const handleRemove = (userId: string) => {
    const userName = users.find((u) => u.id === userId)?.name ?? "this user";
    setConfirmAction({
      title: "Delete user permanently?",
      message: `${userName} and all their data (workspaces, profiles, keys) will be permanently deleted. This cannot be undone.`,
      variant: "danger",
      label: "Delete User",
      action: async () => {
        setError("");
        try {
          await authClient.admin.removeUser({ userId });
          setSelectedUser(null);
          fetchUsers();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to remove user");
        }
        setConfirmAction(null);
      },
    });
  };

  const handleCreate = async () => {
    if (!newEmail || !newPassword || !newName) return;
    setError("");
    try {
      await authClient.admin.createUser({ name: newName, email: newEmail, password: newPassword, role: newRole as "user" | "admin" });
      setShowCreate(false);
      setNewName(""); setNewEmail(""); setNewPassword(""); setNewRole("user");
      fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user");
    }
  };

  const pendingInvites = invites.filter((i) => !i.used_at && new Date(i.expires_at) > new Date());

  const userCols: DataColumn<UserInfo>[] = [
    {
      key: "name",
      label: "Name",
      render: (u) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{u.name}</span>,
    },
    {
      key: "email",
      label: "Email",
      render: (u) => <span style={{ fontSize: 12.5, color: "var(--vz-muted)" }}>{u.email}</span>,
    },
    {
      key: "role",
      label: "Role",
      width: "90px",
      render: (u) => <Pill tone={u.role === "admin" ? "info" : undefined}>{u.role}</Pill>,
    },
    {
      key: "status",
      label: "Status",
      width: "110px",
      render: (u) => u.banned ? <Pill tone="warn">banned</Pill> : <Pill tone="ok" dot>active</Pill>,
    },
    ...(ollamaGlobal ? [{
      key: "ollama",
      label: "Ollama",
      width: "70px",
      align: "center" as const,
      render: (u: UserInfo) => hasFlag(u.featureFlags, "ollama")
        ? <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--vz-ok)" }} title="Enabled" />
        : <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--vz-border-strong)" }} title="Disabled" />,
    }] : []),
    {
      key: "created",
      label: "Created",
      width: "140px",
      render: (u) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatDate(u.createdAt)}</span>,
    },
  ];

  return (
    <>
      {error && (
        <div
          style={{
            fontSize: 13,
            color: "var(--vz-fail)",
            background: "rgba(220, 38, 38, 0.08)",
            border: "1px solid rgba(220, 38, 38, 0.25)",
            padding: "10px 12px",
            borderRadius: "var(--vz-radius-md)",
            marginBottom: 16,
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          {error}
        </div>
      )}

      {inviteResult && (
        <Card style={{ marginBottom: 16, borderLeft: "3px solid var(--vz-ok)" }}>
          <p style={{ fontSize: 13.5, color: "var(--vz-ink)", margin: 0 }}>
            Invite sent to <strong>{inviteResult.email}</strong>
          </p>
          {inviteResult.token && (
            <p style={{ fontSize: 11, color: "var(--vz-muted)", marginTop: 6, fontFamily: "var(--vz-font-mono)" }}>
              Manual link (email failed): <code>{window.location.origin}/invite?token={inviteResult.token}</code>
            </p>
          )}
          <button
            onClick={() => setInviteResult(null)}
            style={{ marginTop: 8, fontSize: 12, color: "var(--vz-muted)", background: "none", border: 0, cursor: "pointer", padding: 0, fontFamily: "var(--vz-font-mono)" }}
          >
            dismiss
          </button>
        </Card>
      )}

      {pendingInvites.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vz-muted-2)", marginBottom: 10 }}>
            Pending invites
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pendingInvites.map((i) => (
              <div key={i.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "var(--vz-ink-3)", display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {i.email}
                  <Pill tone="info">{i.role}</Pill>
                </span>
                <button
                  type="button"
                  onClick={() => handleRevokeInvite(i.id)}
                  style={{ fontSize: 11, color: "var(--vz-fail)", background: "none", border: 0, cursor: "pointer", fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em" }}
                >
                  revoke
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <DataTable
        title="Users"
        count={users.length}
        columns={userCols}
        rows={users}
        rowKey={(u) => u.id}
        onRowClick={(u) => setSelectedUser(u)}
        loading={loading}
        emptyState={<EmptyState icon={<UsersIcon size={20} />} title="No users yet" />}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<UserPlus size={14} />}
              onClick={() => { setShowInvite((v) => !v); setShowCreate(false); }}
            >
              {showInvite ? "Cancel invite" : "Invite user"}
            </Button>
            <Button
              size="sm"
              icon={<UsersIcon size={14} />}
              onClick={() => { setShowCreate((v) => !v); setShowInvite(false); }}
            >
              {showCreate ? "Cancel" : "Create user"}
            </Button>
          </>
        }
      />

      {/* Inline invite panel */}
      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite user"
        size="md"
        dismissable={false}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button size="sm" onClick={handleInvite}>Send invite</Button>
          </>
        }
      >
        <FormStack>
          <Field label="Email">
            <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com" />
          </Field>
          <Field label="Role">
            <Select
              options={[{ value: "user", label: "User" }, { value: "admin", label: "Admin" }]}
              value={inviteRole}
              onChange={setInviteRole}
            />
          </Field>
        </FormStack>
      </Modal>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create user"
        size="md"
        dismissable={false}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Create</Button>
          </>
        }
      >
        <FormStack>
          <Field label="Name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" />
          </Field>
          <Field label="Email">
            <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" />
          </Field>
          <Field label="Password" hint="Minimum 8 characters">
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <Field label="Role">
            <Select
              options={[{ value: "user", label: "User" }, { value: "admin", label: "Admin" }]}
              value={newRole}
              onChange={setNewRole}
            />
          </Field>
        </FormStack>
      </Modal>

      {/* User detail */}
      <Modal
        open={!!selectedUser}
        onClose={() => setSelectedUser(null)}
        title={selectedUser?.name ?? ""}
        description={selectedUser?.email}
        size="lg"
      >
        {selectedUser && (
          <FormStack>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <SubLabel>Created</SubLabel>
                <span style={{ fontSize: 13, color: "var(--vz-ink-3)" }}>{formatDate(selectedUser.createdAt)}</span>
              </div>
              <div>
                <SubLabel>Status</SubLabel>
                {selectedUser.banned ? <Pill tone="warn">banned</Pill> : <Pill tone="ok" dot>active</Pill>}
              </div>
            </div>

            <Field label="Role">
              <Select
                value={selectedUser.role ?? "user"}
                onChange={(v) => handleSetRole(selectedUser.id, v as "user" | "admin")}
                options={[{ value: "user", label: "User" }, { value: "admin", label: "Admin" }]}
                disabled={selectedUser.id === currentUser.id}
              />
            </Field>

            {ollamaGlobal && (
              <div>
                <SubLabel>Feature access</SubLabel>
                <Toggle
                  checked={hasFlag(selectedUser.featureFlags, "ollama")}
                  onChange={() => handleToggleFlag(selectedUser.id, "ollama", selectedUser.featureFlags ?? "")}
                >
                  Ollama Cloud — access to open models via Ollama
                </Toggle>
              </div>
            )}

            {selectedUser.id !== currentUser.id && (
              <div style={{ borderTop: "1px solid var(--vz-border)", paddingTop: 14, marginTop: 4 }}>
                <SubLabel>Actions</SubLabel>
                <div style={{ display: "flex", gap: 8 }}>
                  {selectedUser.banned ? (
                    <Button variant="ghost" size="sm" icon={<ShieldCheck size={14} />} onClick={() => handleUnban(selectedUser.id)}>
                      Unban
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" icon={<Ban size={14} />} onClick={() => handleBan(selectedUser.id)}>
                      Ban
                    </Button>
                  )}
                  <Button variant="danger" size="sm" icon={<TrashIcon size={14} />} onClick={() => handleRemove(selectedUser.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </FormStack>
        )}
      </Modal>

      <Modal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.message ?? ""}
        size="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button
              variant={confirmAction?.variant === "danger" ? "danger" : "primary"}
              size="sm"
              onClick={() => confirmAction?.action()}
            >
              {confirmAction?.label}
            </Button>
          </>
        }
      />
    </>
  );
}

// ─── Local layout helpers (page-only) ────────────────────────────────
function FormStack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>;
}

function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--vz-muted-2)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}


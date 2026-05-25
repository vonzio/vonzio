/**
 * Profiles — agent configuration library.
 * Tabs: Profiles (primary), Tools, Skills, Subagents.
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  Bot, Plus, Trash2, Pencil, Key as KeyIcon, Wrench, BookOpen, Copy,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import {
  fetchProfiles, deleteProfile,
  fetchUserTools, createUserTool, deleteUserTool,
  fetchUserSkills, createUserSkill, deleteUserSkill,
  fetchUserAgents, createUserAgent, deleteUserAgent,
  type ProfileSummary,
} from "../api/client.js";
import {
  PageHeader, PageBody, Tabs, Card, Button, Field, Input, Textarea, Select,
  Checkbox, Pill, Badge, Modal, EmptyState, DataTable,
  type DataColumn,
} from "../brand/components.js";
import { useUser } from "../contexts/UserContext.js";

const tabDefs = [
  { value: "profiles", label: "Profiles" },
  { value: "tools", label: "Tools" },
  { value: "skills", label: "Skills" },
  { value: "agents", label: "Subagents" },
];

export function MyAgents() {
  const validIds = tabDefs.map((t) => t.value);
  const hashTab = window.location.hash.slice(1);
  const [activeTab, setActiveTabRaw] = useState(validIds.includes(hashTab) ? hashTab : "profiles");

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

  const ledeMap: Record<string, string> = {
    profiles: "A profile bundles the model, tools, skills, subagents, and rules that define how an agent runs.",
    tools: "JavaScript tools the agent can invoke directly.",
    skills: "Skills the agent can pull in when relevant — markdown playbooks for specialised workflows.",
    agents: "Specialised subagents the main agent can delegate tasks to.",
  };

  return (
    <>
      <PageHeader
        eyebrow="Library"
        title="Profiles"
        lede={ledeMap[activeTab]}
      />
      <PageBody>
        <Tabs tabs={tabDefs} value={activeTab} onChange={setActiveTab} />
        <div style={{ marginTop: 24 }}>
          {activeTab === "profiles" && <ProfileSection />}
          {activeTab === "tools" && <ToolSection />}
          {activeTab === "skills" && <SkillSection />}
          {activeTab === "agents" && <SubagentSection />}
        </div>
      </PageBody>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Profiles
// ───────────────────────────────────────────────────────────────────

function slugifyName(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return base || "agent";
}

function ProfileSection() {
  const user = useUser();
  const navigate = useNavigate();
  const { data: profiles, loading, refetch } = useApi<ProfileSummary[]>(() => fetchProfiles());

  // Form state + Modal lived here until v0.1.x — now hoisted into the
  // dedicated /agents/:id/edit page (EditAgent.tsx). What's left in this
  // section is the listing + the delete-confirm modal. All "open editor"
  // affordances navigate to the dedicated page instead.
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    try { await deleteProfile(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const ownProfiles = profiles?.filter((p) => p.user_id === user.id) ?? [];
  const sharedProfiles = profiles?.filter((p) => !p.user_id) ?? [];
  const isFirstProfile = ownProfiles.length === 0 && !loading;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vz-muted-2)" }}>
          {ownProfiles.length > 0 ? `Your profiles · ${ownProfiles.length}` : ""}
        </div>
        {!isFirstProfile && (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate("/agents/new")}>
            New profile
          </Button>
        )}
      </div>

      {loading ? (
        <div style={{ padding: "48px 0", textAlign: "center", fontFamily: "var(--vz-font-mono)", fontSize: 12, color: "var(--vz-muted)" }}>
          loading…
        </div>
      ) : isFirstProfile ? (
        <EmptyState
          icon={<Bot size={22} />}
          title="No profiles yet"
          description="A profile bundles your API key, tools, skills, and subagents. Create one or clone a shared profile to get started."
          action={
            <div style={{ display: "flex", gap: 8 }}>
              {sharedProfiles[0] && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Copy size={14} />}
                  onClick={() => navigate(`/agents/new?from=${sharedProfiles[0].id}`)}
                >
                  Clone “{sharedProfiles[0].name}”
                </Button>
              )}
              <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate("/agents/new")}>
                New profile
              </Button>
            </div>
          }
        />
      ) : (
        <div className="vz-card-grid">
          {ownProfiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              onEdit={() => navigate(`/agents/${p.id}/edit`)}
              onDuplicate={() => navigate(`/agents/new?from=${p.id}`)}
              onDelete={ownProfiles.length > 1 ? () => setConfirmDeleteId(p.id) : undefined}
            />
          ))}
        </div>
      )}

      {sharedProfiles.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vz-muted-2)", marginBottom: 12 }}>
            Shared · {sharedProfiles.length}
          </div>
          <div className="vz-card-grid">
            {sharedProfiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                shared
                onDuplicate={() => navigate(`/agents/new?from=${p.id}`)}
              />
            ))}
          </div>
        </div>
      )}

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete profile?"
        description="This profile will be removed. Sessions running with this profile finish on their old config; future runs need a different profile."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}

function ProfileCard({
  profile,
  shared,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  profile: ProfileSummary;
  shared?: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const toolCount = profile.default_tools?.length ?? 0;
  const hasKey = !!profile.api_key_id;

  return (
    <Card
      className="vz-card--hoverable"
      onClick={onEdit ?? onDuplicate}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 15, color: "var(--vz-ink)", letterSpacing: "-0.01em" }}>
              {profile.name}
            </span>
            {shared && <Pill tone="info">shared</Pill>}
            {hasKey && !shared && (
              <span title="API key set" style={{ display: "inline-flex", color: "var(--vz-ok)" }}>
                <KeyIcon size={13} />
              </span>
            )}
          </div>
          {profile.slug && (
            <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", marginTop: 2 }}>
              @{profile.slug}
            </div>
          )}
        </div>
        <div className="vz-card__actions-revealed" onClick={(e) => e.stopPropagation()}>
          {onEdit && (
            <button type="button" className="vz-action-btn" title="Edit" onClick={onEdit}>
              <Pencil size={13} />
            </button>
          )}
          {onDuplicate && (
            <button type="button" className="vz-action-btn" title="Duplicate" onClick={onDuplicate}>
              <Copy size={13} />
            </button>
          )}
          {onDelete && (
            <button type="button" className="vz-action-btn vz-action-btn--danger" title="Delete" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex", flexWrap: "wrap", gap: 6,
          fontFamily: "var(--vz-font-mono)", fontSize: 11.5,
          color: "var(--vz-muted)",
          paddingTop: 10,
          borderTop: "1px dashed var(--vz-border)",
        }}
      >
        <span>{toolCount === 0 ? "all tools" : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`}</span>
      </div>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────
// Tools
// ───────────────────────────────────────────────────────────────────

function ToolSection() {
  const { data: tools, loading, refetch } = useApi<Record<string, unknown>[]>(() => fetchUserTools());
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toolName, setToolName] = useState("");
  const [toolDesc, setToolDesc] = useState("");
  const [toolCode, setToolCode] = useState("");

  const handleCreate = async () => {
    if (!toolName || !toolCode) return;
    setError("");
    try {
      await createUserTool({ name: toolName, description: toolDesc, file_name: `${toolName}.js`, code: toolCode });
      setToolName(""); setToolDesc(""); setToolCode("");
      setShowForm(false);
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteUserTool(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const yours = (tools ?? []).filter((t) => t.source !== "filesystem");
  const bundled = (tools ?? []).filter((t) => t.source === "filesystem");

  return (
    <CatalogLayout
      error={error}
      onErrorDismiss={() => setError("")}
      onAdd={() => setShowForm(true)}
      addLabel="New tool"
      loading={loading}
      yours={yours}
      bundled={bundled}
      yoursColumns={catalogToolColumns}
      bundledColumns={catalogToolColumnsReadOnly}
      yoursTitle="Yours"
      bundledTitle="Bundled"
      bundledDescription="Shipped with the platform — read only."
      onDelete={(id) => setConfirmDeleteId(id)}
      emptyIcon={<Wrench size={20} />}
      emptyTitle="No tools yet"
      emptyDescription="Upload a JavaScript module the agent can invoke as a tool."
    >
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        size="lg"
        dismissable={false}
        title="Upload tool"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Upload</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <Input value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="my-tool" />
          </Field>
          <Field label="Description">
            <Input value={toolDesc} onChange={(e) => setToolDesc(e.target.value)} placeholder="What it does" />
          </Field>
          <Field label="Code (JavaScript module)">
            <Textarea
              value={toolCode}
              onChange={(e) => setToolCode(e.target.value)}
              rows={10}
              placeholder="module.exports = { name: 'my-tool', handler: async (args) => { ... } }"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete tool?"
        description="Profiles using this tool will lose access to it on their next run."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>
              Delete
            </Button>
          </>
        }
      />
    </CatalogLayout>
  );

  // local cols (closures over confirm/delete)
  function catalogToolColumns(): DataColumn<Record<string, unknown>>[] {
    return [
      {
        key: "name",
        label: "Name",
        render: (t) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{t.name as string}</span>,
      },
      {
        key: "_actions",
        label: "",
        width: "60px",
        align: "right",
        render: (t) => (
          <button
            type="button"
            className="vz-action-btn vz-action-btn--danger"
            title="Delete"
            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(t.id as string); }}
          >
            <Trash2 size={13} />
          </button>
        ),
      },
    ];
  }

  function catalogToolColumnsReadOnly(): DataColumn<Record<string, unknown>>[] {
    return [
      {
        key: "name",
        label: "Name",
        render: (t) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{t.name as string}</span>,
      },
      { key: "source", label: "Source", render: () => <Pill tone="info">bundled</Pill> },
    ];
  }
}

// ───────────────────────────────────────────────────────────────────
// Skills
// ───────────────────────────────────────────────────────────────────

function SkillSection() {
  const { data: skills, loading, refetch } = useApi<Record<string, unknown>[]>(() => fetchUserSkills());
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillContent, setSkillContent] = useState("");

  const handleCreate = async () => {
    if (!skillName || !skillContent) return;
    setError("");
    try {
      await createUserSkill({ name: skillName, description: skillDesc, content: skillContent });
      setSkillName(""); setSkillDesc(""); setSkillContent("");
      setShowForm(false);
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteUserSkill(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const yours = (skills ?? []).filter((s) => s.source !== "filesystem");
  const bundled = (skills ?? []).filter((s) => s.source === "filesystem");

  const yoursCols: DataColumn<Record<string, unknown>>[] = [
    {
      key: "name",
      label: "Name",
      render: (s) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{s.name as string}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (s) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>
          {((s.description as string) ?? "").slice(0, 80) || <span style={{ color: "var(--vz-muted-2)" }}>—</span>}
        </span>
      ),
    },
    {
      key: "_actions",
      label: "",
      width: "60px",
      align: "right",
      render: (s) => (
        <button
          type="button"
          className="vz-action-btn vz-action-btn--danger"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id as string); }}
        >
          <Trash2 size={13} />
        </button>
      ),
    },
  ];

  const bundledCols: DataColumn<Record<string, unknown>>[] = [
    {
      key: "name",
      label: "Name",
      render: (s) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{s.name as string}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (s) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>
          {((s.description as string) ?? "").slice(0, 80) || <span style={{ color: "var(--vz-muted-2)" }}>—</span>}
        </span>
      ),
    },
    { key: "source", label: "Source", render: () => <Pill tone="info">bundled</Pill> },
  ];

  return (
    <CatalogLayout
      error={error}
      onErrorDismiss={() => setError("")}
      onAdd={() => setShowForm(true)}
      addLabel="New skill"
      loading={loading}
      yours={yours}
      bundled={bundled}
      yoursColumns={() => yoursCols}
      bundledColumns={() => bundledCols}
      yoursTitle="Yours"
      bundledTitle="Bundled"
      bundledDescription="Shipped with the platform — read only."
      onDelete={(id) => setConfirmDeleteId(id)}
      emptyIcon={<BookOpen size={20} />}
      emptyTitle="No skills yet"
      emptyDescription="Skills are markdown playbooks the agent can pull in when relevant."
    >
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        size="lg"
        dismissable={false}
        title="New skill"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Add skill</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <Input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="code-review" />
          </Field>
          <Field label="Description">
            <Input value={skillDesc} onChange={(e) => setSkillDesc(e.target.value)} placeholder="What this skill does" />
          </Field>
          <Field label="Content (markdown)">
            <Textarea value={skillContent} onChange={(e) => setSkillContent(e.target.value)} rows={12} placeholder={`# ${skillName || "skill-name"}\n\nWhen asked to …\n\n1. …\n2. …`} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete skill?"
        description="Profiles using this skill will lose access to it on their next run."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>
              Delete
            </Button>
          </>
        }
      />
    </CatalogLayout>
  );
}

// ───────────────────────────────────────────────────────────────────
// Subagents
// ───────────────────────────────────────────────────────────────────

function SubagentSection() {
  const { data: agents, loading, refetch } = useApi<Record<string, unknown>[]>(() => fetchUserAgents());
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentDesc, setAgentDesc] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentModel, setAgentModel] = useState("");

  const handleCreate = async () => {
    if (!agentName || !agentPrompt) return;
    setError("");
    try {
      await createUserAgent({ name: agentName, description: agentDesc, prompt: agentPrompt, model: agentModel || undefined });
      setAgentName(""); setAgentDesc(""); setAgentPrompt(""); setAgentModel("");
      setShowForm(false);
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteUserAgent(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const cols: DataColumn<Record<string, unknown>>[] = [
    {
      key: "name",
      label: "Name",
      render: (a) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{a.name as string}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (a) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>
          {((a.description as string) ?? "").slice(0, 80) || <span style={{ color: "var(--vz-muted-2)" }}>—</span>}
        </span>
      ),
    },
    {
      key: "model",
      label: "Model",
      width: "100px",
      render: (a) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>
          {(a.model as string) || "inherit"}
        </span>
      ),
    },
    {
      key: "_actions",
      label: "",
      width: "60px",
      align: "right",
      render: (a) => (
        <button
          type="button"
          className="vz-action-btn vz-action-btn--danger"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(a.id as string); }}
        >
          <Trash2 size={13} />
        </button>
      ),
    },
  ];

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      <DataTable
        title="Subagents"
        count={agents?.length}
        columns={cols}
        rows={agents ?? []}
        rowKey={(a) => a.id as string}
        loading={loading}
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>
            New subagent
          </Button>
        }
        emptyState={
          <EmptyState
            icon={<Bot size={20} />}
            title="No subagents yet"
            description="Subagents are specialised agents the main agent can delegate tasks to."
          />
        }
      />

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        size="lg"
        dismissable={false}
        title="New subagent"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Add subagent</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Name">
              <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="test-runner" />
            </Field>
            <Field label="Model">
              {/* Sub-agents float across profiles/providers, so we can't fetch
                  a live model list (no API key to query against). Aliases are
                  the right tool here — the SDK resolves them against whichever
                  profile's key invokes the sub-agent at runtime. */}
              <Select
                options={[
                  { value: "", label: "Inherit" },
                  { value: "sonnet", label: "Sonnet" },
                  { value: "opus", label: "Opus" },
                  { value: "haiku", label: "Haiku" },
                ]}
                value={agentModel}
                onChange={setAgentModel}
              />
            </Field>
          </div>
          <Field label="Description">
            <Input value={agentDesc} onChange={(e) => setAgentDesc(e.target.value)} placeholder="Runs tests and reports results" />
          </Field>
          <Field label="System prompt">
            <Textarea value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} rows={8} placeholder="You are a test runner that…" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete subagent?"
        description="Profiles using this subagent will lose access to it on their next run."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Shared catalog layout (Tools / Skills) — bundled vs yours
// ───────────────────────────────────────────────────────────────────

function CatalogLayout({
  error,
  onErrorDismiss,
  onAdd,
  addLabel,
  loading,
  yours,
  bundled,
  yoursColumns,
  bundledColumns,
  yoursTitle,
  bundledTitle,
  bundledDescription,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  children,
}: {
  error: string;
  onErrorDismiss: () => void;
  onAdd: () => void;
  addLabel: string;
  loading: boolean;
  yours: Record<string, unknown>[];
  bundled: Record<string, unknown>[];
  yoursColumns: () => DataColumn<Record<string, unknown>>[];
  bundledColumns: () => DataColumn<Record<string, unknown>>[];
  yoursTitle: string;
  bundledTitle: string;
  bundledDescription: string;
  onDelete: (id: string) => void;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  children?: ReactNode;
}) {
  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={onErrorDismiss} />}

      <DataTable
        title={yoursTitle}
        count={yours.length}
        columns={yoursColumns()}
        rows={yours}
        rowKey={(t) => t.id as string}
        loading={loading}
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={onAdd}>{addLabel}</Button>}
        emptyState={
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDescription}
            action={<Button size="sm" icon={<Plus size={14} />} onClick={onAdd}>{addLabel}</Button>}
          />
        }
      />

      {bundled.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <DataTable
            title={
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                {bundledTitle}
                <span style={{ fontSize: 11, color: "var(--vz-muted-2)", fontWeight: 400, fontFamily: "var(--vz-font-mono)" }}>
                  {bundledDescription}
                </span>
              </span>
            }
            count={bundled.length}
            columns={bundledColumns()}
            rows={bundled}
            rowKey={(t) => t.id as string}
          />
        </div>
      )}

      {children}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        fontSize: 13, color: "var(--vz-fail)",
        background: "rgba(220, 38, 38, 0.08)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        padding: "10px 12px",
        borderRadius: "var(--vz-radius-md)",
        marginBottom: 16,
        fontFamily: "var(--vz-font-mono)",
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        style={{ background: "none", border: 0, cursor: "pointer", color: "var(--vz-fail)", padding: 4, fontFamily: "var(--vz-font-mono)", fontSize: 11 }}
      >
        ×
      </button>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--vz-muted-2)",
        paddingTop: 8,
        marginTop: 4,
        borderTop: "1px solid var(--vz-border)",
      }}
    >
      {children}
    </div>
  );
}

// keep Badge import alive (used by Profile cards if extended later)
void Badge;

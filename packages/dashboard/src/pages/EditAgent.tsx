/**
 * Dedicated route for editing / creating a profile.
 *
 * Replaces the modal that used to live in MyAgents.tsx → ProfileSection.
 * That modal had outgrown its container: 8+ sections, internal scroll
 * nested inside the page scroll, scrim that blocked the rest of the UI
 * while editing. A dedicated page gives us:
 *
 *   - The whole viewport
 *   - Browser back/forward + bookmarkable URL
 *   - Room to add a section anchor rail later
 *   - Clean Cancel = navigate(-1); no modal-close mental model
 *
 * Routes:
 *   /agents/new            — blank form
 *   /agents/new?from=:id   — duplicate-from flow
 *   /agents/:id/edit       — edit existing
 *
 * State + handlers are lifted verbatim from the old ProfileSection
 * modal — same fields, same shape, same handleSave. The only delta is
 * where it renders.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import {
  Button, Field, Input, Textarea, Select, type SelectOption,
  Checkbox, Panel, Tabs, type TabDef, Modal,
} from "../brand/components.js";
import { ErrorBanner } from "./MyAgents.js";
import {
  createProfile, updateProfile,
  fetchUserSkills, fetchUserAgents, createUserAgent, createUserSkill,
  fetchUserGitProviders, type GitProviderInfo,
  fetchUserAnthropicKeys, type UserAnthropicKey,
} from "../api/client.js";
import { fetchDockerImages, type DockerImageInfo } from "../api/admin.js";
import { useApi } from "../hooks/useApi.js";
import { slugify } from "../lib/utils.js";
import { ToolPillSelect } from "../components/ToolPillSelect.js";
import { OllamaModelPicker } from "../components/OllamaModelPicker.js";
import { ProfileModelSelect } from "../components/ProfileModelSelect.js";
import { McpServerEditor, type McpServerConfig } from "../components/McpServerEditor.js";
import { ChecklistRows } from "../components/ChecklistRows.js";

// Tab identifiers — single source of truth so the hash gate, the Tabs
// component, and the JSX render guards can't drift.
const TAB_VALUES = ["overview", "tools", "extensions", "network"] as const;
type TabValue = (typeof TAB_VALUES)[number];

const slugifyName = (value: string): string => slugify(value, 48);

export function EditAgent() {
  const { id: routeId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const duplicateFromId = searchParams.get("from");
  const navigate = useNavigate();

  const editingId = routeId ?? null;
  const isNewMode = !editingId;

  const { data: availableSkills, refetch: refetchSkills } = useApi<Record<string, unknown>[]>(() => fetchUserSkills());
  const { data: availableAgents, refetch: refetchSubagents } = useApi<Record<string, unknown>[]>(() => fetchUserAgents());
  const { data: availableGitProviders } = useApi<GitProviderInfo[]>(() => fetchUserGitProviders());
  const { data: availableImages } = useApi<DockerImageInfo[]>(() => fetchDockerImages().catch(() => []));
  const { data: availableApiKeys } = useApi<UserAnthropicKey[]>(() => fetchUserAnthropicKeys());

  const [error, setError] = useState("");
  const [loadingProfile, setLoadingProfile] = useState(!!editingId || !!duplicateFromId);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEditable, setSlugEditable] = useState(false);
  const [duplicatedFrom, setDuplicatedFrom] = useState<string | null>(null);
  const [profileModel, setProfileModel] = useState("");
  const [effort, setEffort] = useState("");
  const [claudeMd, setClaudeMd] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [egressDomains, setEgressDomains] = useState<string[]>([]);
  const [egressInput, setEgressInput] = useState("");
  const [allowAllEgress, setAllowAllEgress] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [apiKeyId, setApiKeyId] = useState("");
  const [gitProviderIds, setGitProviderIds] = useState<string[]>([]);
  const [containerImage, setContainerImage] = useState("");
  const [setupCommands, setSetupCommands] = useState("");
  const [persistentSessions, setPersistentSessions] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const serverMaxTurns = (window as { __VONZIO_MAX_TURNS?: number }).__VONZIO_MAX_TURNS ?? 200;
  // See MyAgents.tsx for the rationale on these defaults (50/3/$5 for
  // new general-purpose chat profiles, server-cap fallback for
  // pre-existing profiles with null max_turns).
  const [maxTurns, setMaxTurns] = useState("50");
  const [autoContinue, setAutoContinue] = useState(false);
  const [maxContinuations, setMaxContinuations] = useState(3);
  const [continuationBudgetUsd, setContinuationBudgetUsd] = useState("5");

  // Tab navigation. Persists in the URL hash so a Save → navigate("/agents")
  // → back-button returns the user to the tab they were on. Names live in
  // one place so a rename can't desync the hash gate, the tabs array, and
  // the JSX render guards.
  const [activeTab, setActiveTab] = useState<TabValue>(() => {
    const hash = window.location.hash.replace("#", "") as TabValue;
    return TAB_VALUES.includes(hash) ? hash : "overview";
  });
  useEffect(() => {
    const h = `#${activeTab}`;
    if (window.location.hash !== h) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${h}`);
    }
  }, [activeTab]);

  // Inline create flows — users used to have to leave the editor to make
  // a subagent/skill in the global tab. Now they can spawn one without
  // losing form context. Auto-selects the new id on success.
  // `refetchSubagents` / `refetchSkills` are destructured from the SAME
  // useApi calls that populate `availableAgents` / `availableSkills`
  // above — refetching has to update the list the UI actually reads.
  const [newSubagentOpen, setNewSubagentOpen] = useState(false);
  const [newSubagentName, setNewSubagentName] = useState("");
  const [newSubagentDesc, setNewSubagentDesc] = useState("");
  const [newSubagentPrompt, setNewSubagentPrompt] = useState("");
  const [creatingSubagent, setCreatingSubagent] = useState(false);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [newSkillBody, setNewSkillBody] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);

  const selectedKey = (availableApiKeys ?? []).find((k) => k.id === apiKeyId);
  const isOllamaKey = selectedKey?.provider === "ollama";

  // Hydrate from server when editing OR duplicating. The /profiles/:id
  // GET returns the full profile including mcp_servers; in duplicate
  // mode we strip masked secrets so they don't carry across.
  //
  // The `cancelled` flag guards against setState-on-unmount when the user
  // navigates away while the fetch is still in flight (common on slow
  // network or rapid back/forth navigation). Reset `loadingProfile` to
  // true on every effect run so URL changes (different :id) re-show the
  // loading shimmer instead of the stale form.
  useEffect(() => {
    const sourceId = editingId ?? duplicateFromId;
    if (!sourceId) {
      setLoadingProfile(false);
      return;
    }
    let cancelled = false;
    setLoadingProfile(true);
    setNotFound(false);
    const isDuplicate = !editingId && !!duplicateFromId;
    fetch(`/v1/profiles/${sourceId}`, { credentials: "include" })
      .then((r) => {
        if (r.status === 404) {
          if (!cancelled) setNotFound(true);
          throw new Error("Profile not found");
        }
        return r.json();
      })
      .then((full: Record<string, unknown>) => {
        if (cancelled) return;
        if (isDuplicate) {
          setName(`${full.name as string} (copy)`);
          setSlug("");
          setDuplicatedFrom(full.name as string);
        } else {
          setName(full.name as string);
          setSlug((full.slug as string) ?? "");
        }
        const egress = (full.default_egress_domains as string[]) ?? [];
        setAllowAllEgress(egress.includes("*"));
        setEgressDomains(egress.filter((d) => d !== "*"));
        setApiKeyId((full.api_key_id as string) ?? "");
        setClaudeMd((full.claude_md as string) ?? "");
        const rawMcp = (full.mcp_servers as McpServerConfig[]) ?? [];
        const mcp = isDuplicate
          ? rawMcp.map((s) => ({
              ...s,
              env: s.env ? Object.fromEntries(Object.entries(s.env).filter(([, v]) => v !== "••••••••")) : undefined,
              headers: s.headers ? Object.fromEntries(Object.entries(s.headers).filter(([, v]) => v !== "••••••••")) : undefined,
            }))
          : rawMcp;
        setMcpServers(mcp);
        setTools((full.default_tools as string[]) ?? []);
        setAgentIds((full.agent_ids as string[]) ?? []);
        setSkillIds((full.skill_ids as string[]) ?? []);
        setGitProviderIds((full.git_provider_ids as string[]) ?? (full.git_provider_id ? [full.git_provider_id as string] : []));
        setProfileModel((full.model as string) ?? "");
        setEffort((full.effort as string) ?? "");
        setContainerImage((full.container_image as string) ?? "");
        setSetupCommands(((full.setup_commands as string[]) ?? []).join("\n"));
        setPersistentSessions((full.persistent_sessions as boolean) ?? true);
        setMemoryEnabled((full.memory_enabled as boolean) ?? true);
        setMaxTurns(String(full.max_turns ?? serverMaxTurns));
        setAutoContinue((full.auto_continue as boolean) ?? true);
        setMaxContinuations((full.max_continuations as number) ?? 5);
        setContinuationBudgetUsd(full.continuation_budget_usd != null ? String(full.continuation_budget_usd) : "");
      })
      .catch(() => {
        // notFound already set above; other errors leave the form blank.
      })
      .finally(() => {
        if (!cancelled) setLoadingProfile(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, duplicateFromId, serverMaxTurns]);

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name, slug: slug.trim() || undefined,
        api_key_id: apiKeyId || null, model: profileModel || undefined, effort: effort || undefined,
        default_tools: tools, default_egress_domains: allowAllEgress ? ["*"] : egressDomains,
        claude_md: claudeMd.trim() || "", mcp_servers: mcpServers,
        agent_ids: agentIds, skill_ids: skillIds, git_provider_ids: gitProviderIds,
        container_image: containerImage || undefined,
        setup_commands: setupCommands.trim() ? setupCommands.split("\n").map((s) => s.trim()).filter(Boolean) : [],
        persistent_sessions: persistentSessions,
        memory_enabled: memoryEnabled,
        max_turns: (() => {
          const n = parseInt(maxTurns);
          return Number.isFinite(n) && n > 0 ? n : null;
        })(),
        auto_continue: autoContinue,
        max_continuations: autoContinue ? maxContinuations : undefined,
        continuation_budget_usd: autoContinue && continuationBudgetUsd ? parseFloat(continuationBudgetUsd) : null,
      };
      if (editingId) await updateProfile(editingId, body);
      else await createProfile(body);
      navigate("/agents");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  const apiKeyOptions: SelectOption[] = [
    { value: "", label: "Select an API key…" },
    ...(availableApiKeys ?? []).map((k) => ({ value: k.id, label: `${k.name} (${k.provider})` })),
  ];

  // Quick-create subagent. Posts, picks the new id back into agentIds, refetches.
  async function handleCreateSubagent() {
    if (!newSubagentName.trim() || !newSubagentPrompt.trim()) return;
    setCreatingSubagent(true);
    try {
      const created = (await createUserAgent({
        name: newSubagentName.trim(),
        description: newSubagentDesc.trim() || undefined,
        prompt: newSubagentPrompt.trim(),
      })) as { id?: string };
      // Dedupe: guard against the corner case where a retried submit lands
      // a stale id from a previous attempt already in the array.
      if (created?.id) setAgentIds((prev) => prev.includes(created.id!) ? prev : [...prev, created.id!]);
      await refetchSubagents();
      setNewSubagentName(""); setNewSubagentDesc(""); setNewSubagentPrompt("");
      setNewSubagentOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create subagent");
    } finally {
      setCreatingSubagent(false);
    }
  }

  async function handleCreateSkill() {
    if (!newSkillName.trim() || !newSkillBody.trim()) return;
    setCreatingSkill(true);
    try {
      const created = (await createUserSkill({
        name: newSkillName.trim(),
        description: newSkillDesc.trim() || undefined,
        // Server expects `content`, not `body` (see /v1/skills POST handler).
        content: newSkillBody.trim(),
      })) as { id?: string };
      if (created?.id) setSkillIds((prev) => prev.includes(created.id!) ? prev : [...prev, created.id!]);
      await refetchSkills();
      setNewSkillName(""); setNewSkillDesc(""); setNewSkillBody("");
      setNewSkillOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create skill");
    } finally {
      setCreatingSkill(false);
    }
  }

  const tabs: TabDef[] = [
    { value: "overview", label: "Overview" },
    { value: "tools", label: "Tools & MCP" },
    { value: "extensions", label: "Subagents & skills" },
    { value: "network", label: "Network & advanced" },
  ];

  if (loadingProfile) {
    return (
      <div style={{ padding: 48, textAlign: "center", fontFamily: "var(--vz-font-mono)", fontSize: 12, color: "var(--vz-muted)" }}>
        loading profile…
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ padding: 32, maxWidth: 480 }}>
        <Link
          to="/agents"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontFamily: "var(--vz-font-mono)", fontSize: 12,
            color: "var(--vz-muted-2)", textDecoration: "none",
            marginBottom: 16,
          }}
        >
          <ArrowLeft size={14} /> Back to agents
        </Link>
        <div style={{ fontSize: 14, color: "var(--vz-ink-3)" }}>
          Profile not found. It may have been deleted or you don't have access.
        </div>
      </div>
    );
  }

  const pageTitle = editingId
    ? `Edit · ${name || "profile"}`
    : duplicatedFrom
      ? `Clone of ${duplicatedFrom}`
      : "New profile";

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 32px 64px" }}>
      {/* Header — back link + title + actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
        <Link
          to="/agents"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontFamily: "var(--vz-font-mono)", fontSize: 11,
            letterSpacing: "0.08em", textTransform: "uppercase",
            color: "var(--vz-muted-2)", textDecoration: "none",
            width: "fit-content",
          }}
        >
          <ArrowLeft size={12} /> Back to agents
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--vz-ink)", margin: 0 }}>
            {pageTitle}
          </h1>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => navigate("/agents")}>Cancel</Button>
            <Button size="sm" onClick={handleSave}>
              {saving ? "Saving…" : editingId ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </div>

      {/* Error banner — inline, page-top. Always visible since there's no
          modal scrim to hide behind. */}
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: error ? 16 : 0 }}>
        {duplicatedFrom && (
          <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--vz-radius-md)", padding: 12, fontSize: 12.5, color: "var(--vz-warn)", fontFamily: "var(--vz-font-mono)" }}>
            Cloned from <strong>{duplicatedFrom}</strong>. MCP secrets and registry passwords are <em>not</em> copied — re-enter them below if needed.
          </div>
        )}

        {/* Tabbed layout. Each tab body is a stack of <Panel>s — gives the
            page the same boxed structure the rest of the dashboard uses
            (Settings, Operations) and lets the user jump between concerns
            without scrolling a ~6-screen wall. Hash persists the active
            tab so reloading or coming back via browser-back lands on the
            same place. */}
        <Tabs tabs={tabs} value={activeTab} onChange={(v) => setActiveTab(v as TabValue)}>
          {activeTab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              <Panel title="Identity">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="Name">
                    <Input
                      value={name}
                      onChange={(e) => {
                        const v = e.target.value;
                        setName(v);
                        if (!slugEditable && isNewMode) setSlug(slugifyName(v));
                      }}
                      placeholder="e.g. Software Developer"
                    />
                  </Field>
                  <Field label="Slug" hint={`@mention shortcut for Slack — e.g. @${slug || "coder"} build me a brief.`}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        value={slug}
                        readOnly={!slugEditable}
                        onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-/, ""))}
                        onBlur={(e) => setSlug(e.target.value.replace(/-$/, ""))}
                        placeholder="auto-generated from name"
                        className="vz-input"
                        style={{ flex: 1 }}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setSlugEditable((v) => !v)}>
                        {slugEditable ? "Lock" : "Edit"}
                      </Button>
                    </div>
                  </Field>
                </div>
              </Panel>

              <Panel title="Model">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="API key">
                    <Select
                      options={apiKeyOptions}
                      value={apiKeyId}
                      onChange={(v) => {
                        const newKey = (availableApiKeys ?? []).find((k) => k.id === v);
                        if ((newKey?.provider === "ollama") !== isOllamaKey) setProfileModel("");
                        setApiKeyId(v);
                      }}
                    />
                  </Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {isOllamaKey ? (
                      <div>
                        <span style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--vz-muted)", letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: "var(--vz-font-mono)", marginBottom: 6 }}>
                          Model
                        </span>
                        <OllamaModelPicker apiKeyId={apiKeyId} value={profileModel} onChange={setProfileModel} />
                      </div>
                    ) : (
                      <Field label="Model">
                        <ProfileModelSelect
                          profileId={editingId}
                          value={profileModel}
                          onChange={setProfileModel}
                        />
                      </Field>
                    )}
                    <Field label="Effort">
                      <Select
                        options={[
                          { value: "", label: "High (default)" },
                          { value: "max", label: "Max" },
                          { value: "high", label: "High" },
                          { value: "medium", label: "Medium" },
                          { value: "low", label: "Low" },
                        ]}
                        value={effort}
                        onChange={setEffort}
                      />
                    </Field>
                  </div>
                </div>
              </Panel>

              <Panel title="Runtime">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="Setup commands" hint="Run on container start. One per line.">
                    <Textarea value={setupCommands} onChange={(e) => setSetupCommands(e.target.value)} placeholder="npm install" rows={3} />
                  </Field>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <Checkbox checked={persistentSessions} onChange={setPersistentSessions}>Persistent sessions</Checkbox>
                    <Checkbox checked={memoryEnabled} onChange={setMemoryEnabled}>Agent memory</Checkbox>
                  </div>
                </div>
              </Panel>

              <Panel title="Limits">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <Field label="Max turns / task" hint="Empty = no limit (server cap: 200)">
                      <Input
                        type="number"
                        min={0}
                        max={10000}
                        value={maxTurns}
                        onChange={(e) => setMaxTurns(e.target.value)}
                        placeholder="No limit"
                      />
                    </Field>
                    {autoContinue && (
                      <>
                        <Field label="Max continuations">
                          <Input type="number" min={1} max={200} value={String(maxContinuations)} onChange={(e) => setMaxContinuations(parseInt(e.target.value) || 5)} />
                        </Field>
                        <Field label="Budget cap (USD)" hint="Empty = no cap">
                          <Input type="number" step="0.1" min={0} value={continuationBudgetUsd} onChange={(e) => setContinuationBudgetUsd(e.target.value)} placeholder="No limit" />
                        </Field>
                      </>
                    )}
                  </div>
                  <Checkbox checked={autoContinue} onChange={setAutoContinue}>Auto-continue on turn limit</Checkbox>
                </div>
              </Panel>
            </div>
          )}

          {activeTab === "tools" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              <Panel title="Allowed tools">
                <ToolPillSelect value={tools} onChange={setTools} hint="Empty = all tools available." />
              </Panel>
              <Panel title="MCP servers">
                <McpServerEditor servers={mcpServers} onChange={setMcpServers} />
              </Panel>
            </div>
          )}

          {activeTab === "extensions" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              <Panel
                title="Subagents"
                action={
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setNewSubagentOpen(true)}>
                    New subagent
                  </Button>
                }
              >
                <ChecklistRows
                  items={availableAgents ?? []}
                  selectedIds={agentIds}
                  onChange={setAgentIds}
                  emptyText="No subagents yet — create one with the button above."
                />
              </Panel>
              <Panel
                title="Skills"
                action={
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setNewSkillOpen(true)}>
                    New skill
                  </Button>
                }
              >
                <ChecklistRows
                  items={availableSkills ?? []}
                  selectedIds={skillIds}
                  onChange={setSkillIds}
                  emptyText="No skills yet — create one with the button above."
                />
              </Panel>
            </div>
          )}

          {activeTab === "network" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              <Panel title="System prompt (CLAUDE.md)">
                <Field label="Instructions" hint="Appended to every run. Defines the agent's identity and standing orders.">
                  <Textarea value={claudeMd} onChange={(e) => setClaudeMd(e.target.value)} placeholder="You are a senior engineer who…" rows={10} />
                </Field>
              </Panel>

              <Panel title="Network egress">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Checkbox checked={allowAllEgress} onChange={setAllowAllEgress}>Allow all egress</Checkbox>
                  {!allowAllEgress && (
                    <Field label="Allowed domains" hint="Type a domain and press Enter.">
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        {egressDomains.map((d, i) => (
                          <span
                            key={i}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 6,
                              padding: "2px 8px", borderRadius: "var(--vz-radius-sm)",
                              background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
                              fontSize: 11.5, color: "var(--vz-ink-3)", fontFamily: "var(--vz-font-mono)",
                            }}
                          >
                            {d}
                            <button
                              type="button"
                              onClick={() => setEgressDomains((prev) => prev.filter((_, j) => j !== i))}
                              style={{ background: "none", border: 0, color: "var(--vz-muted-2)", cursor: "pointer", padding: 0 }}
                              aria-label={`Remove ${d}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                      <Input
                        value={egressInput}
                        onChange={(e) => setEgressInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && egressInput.trim()) {
                            e.preventDefault();
                            setEgressDomains((prev) => [...prev, egressInput.trim()]);
                            setEgressInput("");
                          }
                        }}
                        placeholder="github.com, api.openai.com…"
                      />
                    </Field>
                  )}
                </div>
              </Panel>

              <Panel title="Git providers">
                {availableGitProviders?.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {availableGitProviders.map((g) => {
                      const id = g.id as string;
                      const selected = gitProviderIds.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setGitProviderIds((prev) => selected ? prev.filter((x) => x !== id) : [...prev, id])}
                          className="vz-chip"
                          data-active={selected ? "true" : undefined}
                        >
                          {g.name as string}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--vz-muted-2)" }}>No providers configured. Add one in Settings.</span>
                )}
              </Panel>

              {availableImages && availableImages.length > 0 && (
                <Panel title="Container image">
                  <Field label="Runtime image" hint="Most profiles run on the default. Pick another to customize.">
                    <Select
                      options={[
                        { value: "", label: "Default (vonzio-agent:latest)" },
                        ...availableImages.map((img) => ({ value: img.tag, label: img.tag })),
                      ]}
                      value={containerImage}
                      onChange={setContainerImage}
                    />
                  </Field>
                </Panel>
              )}
            </div>
          )}
        </Tabs>

        {/* Sticky action bar at the bottom for long forms — saves a scroll
            for the user who's already scrolled to the bottom anyway. */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24, paddingTop: 24, borderTop: "1px solid var(--vz-border)" }}>
          <Button variant="ghost" size="sm" onClick={() => navigate("/agents")}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>
            {saving ? "Saving…" : editingId ? "Save" : "Create"}
          </Button>
        </div>
      </div>

      {/* ───── Inline-create modals ─────
          Users used to have to leave the editor (and lose form state)
          to make a subagent or skill in the global tab. These modals
          create one inline and auto-select it in the picker. */}
      <Modal
        open={newSubagentOpen}
        onClose={() => setNewSubagentOpen(false)}
        title="New subagent"
        description="Create a specialised agent the main agent can delegate to."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setNewSubagentOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreateSubagent} disabled={creatingSubagent || !newSubagentName.trim() || !newSubagentPrompt.trim()}>
              {creatingSubagent ? "Creating…" : "Create & attach"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Name">
            <Input value={newSubagentName} onChange={(e) => setNewSubagentName(e.target.value)} placeholder="test-runner" />
          </Field>
          <Field label="Description (optional)">
            <Input value={newSubagentDesc} onChange={(e) => setNewSubagentDesc(e.target.value)} placeholder="Runs tests and reports results" />
          </Field>
          <Field label="System prompt">
            <Textarea value={newSubagentPrompt} onChange={(e) => setNewSubagentPrompt(e.target.value)} rows={6} placeholder="You are a test runner that…" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={newSkillOpen}
        onClose={() => setNewSkillOpen(false)}
        title="New skill"
        description="Create a callable skill the main agent can invoke."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setNewSkillOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreateSkill} disabled={creatingSkill || !newSkillName.trim() || !newSkillBody.trim()}>
              {creatingSkill ? "Creating…" : "Create & attach"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Name">
            <Input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="format-pr-summary" />
          </Field>
          <Field label="Description (optional)">
            <Input value={newSkillDesc} onChange={(e) => setNewSkillDesc(e.target.value)} placeholder="Formats a PR summary in our house style" />
          </Field>
          <Field label="Skill content">
            <Textarea value={newSkillBody} onChange={(e) => setNewSkillBody(e.target.value)} rows={6} placeholder="Markdown / instructions the skill exposes when invoked…" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}


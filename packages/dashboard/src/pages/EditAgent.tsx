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
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Upload, ShieldCheck, Globe } from "lucide-react";
import {
  Button, Field, Input, Textarea, Select, type SelectOption,
  Checkbox, Panel, Tabs, type TabDef, Modal, Toggle,
} from "../brand/components.js";
import { ErrorBanner } from "./MyAgents.js";
import {
  createProfile, updateProfile,
  fetchUserSkills, fetchUserAgents, createUserAgent, createUserSkill, uploadSkillFile,
  fetchUserGitProviders, type GitProviderInfo,
  fetchUserAnthropicKeys, type UserAnthropicKey,
  fetchWorkspaces, fetchAgentTemplates,
  fetchProfiles, type ProfileSummary,
} from "../api/client.js";
import { fetchDockerImages, type DockerImageInfo } from "../api/admin.js";
import { useUser } from "../contexts/UserContext.js";
import { useApi } from "../hooks/useApi.js";
import { slugify } from "../lib/utils.js";
import { ToolPillSelect } from "../components/ToolPillSelect.js";
import { KnowledgeSection } from "../components/KnowledgeSection.js";
import { OllamaModelPicker } from "../components/OllamaModelPicker.js";
import { ProfileModelSelect } from "../components/ProfileModelSelect.js";
import { McpServerEditor, type McpServerConfig } from "../components/McpServerEditor.js";
import { ChecklistRows } from "../components/ChecklistRows.js";
import { AgentSecretsPanel } from "../components/AgentSecretsPanel.js";

// Tab identifiers — single source of truth so the hash gate, the Tabs
// component, and the JSX render guards can't drift.
const TAB_VALUES = ["overview", "tools", "extensions", "network"] as const;

// Opt-in platform-MCP capability groups. Mirror of PLATFORM_CAPABILITY_GROUPS in
// @vonzio/shared (the dashboard doesn't depend on shared) — keep in sync; the
// `group` strings must match the gated tool defs in platform-mcp.ts.
const PLATFORM_CAPABILITY_GROUPS: { group: string; label: string; description: string }[] = [
  {
    group: "workspace_destructive",
    label: "Delete workspaces",
    description: "Let this agent permanently delete workspaces (tears down the container and drops the conversation).",
  },
  {
    group: "profiles_write",
    label: "Manage agents",
    description: "Let this agent create, edit, and delete agents (profiles) — including changing its own configuration.",
  },
  {
    group: "preview_access",
    label: "Change preview exposure",
    description: "Let this agent make a workspace's web service publicly reachable (public, or public-with-code). Off by default — turn on only if you want agents to expose ports to the internet.",
  },
];
type TabValue = (typeof TAB_VALUES)[number];

const slugifyName = (value: string): string => slugify(value, 48);

/** Stable signature of an egress config, for detecting changes across a save. */
function egressKey(allowAll: boolean, domains: string[]): string {
  return allowAll ? "*" : [...domains].map((d) => d.trim().toLowerCase()).filter(Boolean).sort().join(",");
}

export function EditAgent() {
  const { id: routeId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const duplicateFromId = searchParams.get("from");
  const templateId = searchParams.get("template");
  const navigate = useNavigate();

  const editingId = routeId ?? null;
  const isNewMode = !editingId;

  const { data: availableSkills, refetch: refetchSkills } = useApi<Record<string, unknown>[]>(() => fetchUserSkills());
  const { data: availableAgents, refetch: refetchSubagents } = useApi<Record<string, unknown>[]>(() => fetchUserAgents());
  const { data: availableGitProviders } = useApi<GitProviderInfo[]>(() => fetchUserGitProviders());
  const { data: availableImages } = useApi<DockerImageInfo[]>(() => fetchDockerImages().catch(() => []));
  const { data: availableApiKeys } = useApi<UserAnthropicKey[]>(() => fetchUserAnthropicKeys());
  const { data: existingProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());

  const [error, setError] = useState("");
  const [loadingProfile, setLoadingProfile] = useState(!!editingId || !!duplicateFromId);
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
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
  // Egress at load time — to detect a change on save and nudge about live
  // sessions (which keep their old network rules until restarted).
  const [initialEgressKey, setInitialEgressKey] = useState("");
  const [egressNudge, setEgressNudge] = useState<number | null>(null);
  // Whether this server enforces egress at the network layer. When false there's
  // no truthful per-agent control to show (domains do nothing) — we show an
  // operator note instead of a toggle.
  const egressEnforced = !!(window as unknown as { __VONZIO_EGRESS_ENFORCEMENT?: boolean }).__VONZIO_EGRESS_ENFORCEMENT;
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [platformCaps, setPlatformCaps] = useState<string[]>([]);
  const [apiKeyId, setApiKeyId] = useState("");
  const [gitProviderIds, setGitProviderIds] = useState<string[]>([]);
  const [containerImage, setContainerImage] = useState("");
  const [setupCommands, setSetupCommands] = useState("");
  const [persistentSessions, setPersistentSessions] = useState(true);
  const [dockerAccess, setDockerAccess] = useState(false);
  const [memoryLimit, setMemoryLimit] = useState("");
  // Feature 0041: default + max workspace memory, injected via /api/config.
  const memDefault = (window as { __VONZIO_MEMORY_LIMIT_DEFAULT?: string }).__VONZIO_MEMORY_LIMIT_DEFAULT ?? "4g";
  const memMaxGb = parseInt((window as { __VONZIO_MEMORY_LIMIT_MAX?: string }).__VONZIO_MEMORY_LIMIT_MAX ?? "16g", 10) || 16;
  const memSizes = [6, 8, 12, 16, 24, 32].filter((n) => n <= memMaxGb).map((n) => `${n}g`);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  // docker_access is a host-security-relevant capability (nested docker daemon,
  // egress/VPN off) — the backend only lets admins enable it, so gate the toggle.
  const isAdmin = useUser().role === "admin";
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
  const [uploadingSkill, setUploadingSkill] = useState(false);
  const skillFileRef = useRef<HTMLInputElement>(null);

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
      // No DB source — but we may be seeding a new agent from a gallery template
      // (`/agents/new?template=<id>`), served from config/agent-templates/*.md.
      if (templateId) {
        let cancelled = false;
        setLoadingProfile(true);
        fetchAgentTemplates()
          .then((list) => {
            if (cancelled) return;
            const t = list.find((x) => x.id === templateId);
            if (!t) return;
            setName(t.name);
            setSlug(t.slug ?? "");
            if (t.claude_md) setClaudeMd(t.claude_md);
            if (t.model) setProfileModel(t.model);
            if (t.effort) setEffort(t.effort);
            if (t.default_tools) setTools(t.default_tools);
            if (t.default_egress_domains) {
              const allowAll = t.default_egress_domains.includes("*");
              setAllowAllEgress(allowAll);
              setEgressDomains(t.default_egress_domains.filter((d) => d !== "*"));
            }
            if (t.setup_commands) setSetupCommands(t.setup_commands.join("\n"));
            setSeededFrom(t.name);
          })
          .catch(() => { /* leave the form blank on failure */ })
          .finally(() => { if (!cancelled) setLoadingProfile(false); });
        return () => { cancelled = true; };
      }
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
          throw new Error("Agent not found");
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
        const allowAll = egress.includes("*");
        const domains = egress.filter((d) => d !== "*");
        setAllowAllEgress(allowAll);
        setEgressDomains(domains);
        // Duplicated agents are brand-new (no live sessions) → no baseline to nudge against.
        if (!isDuplicate) setInitialEgressKey(egressKey(allowAll, domains));
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
        setPlatformCaps((full.platform_capabilities as string[]) ?? []);
        setGitProviderIds((full.git_provider_ids as string[]) ?? (full.git_provider_id ? [full.git_provider_id as string] : []));
        setProfileModel((full.model as string) ?? "");
        setEffort((full.effort as string) ?? "");
        setContainerImage((full.container_image as string) ?? "");
        setSetupCommands(((full.setup_commands as string[]) ?? []).join("\n"));
        setPersistentSessions((full.persistent_sessions as boolean) ?? true);
        setDockerAccess((full.docker_access as boolean) ?? false);
        setMemoryLimit((full.memory_limit as string) ?? "");
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
  }, [editingId, duplicateFromId, templateId, serverMaxTurns]);

  // Default the API key for a NEW agent (blank or template-seeded) so the user
  // isn't forced to pick one. There's no `is_default` key field, so the heuristic
  // is: most-recently-used key, falling back to the only/first key. Never
  // overrides an explicit choice or a key carried over by duplicate-from.
  useEffect(() => {
    if (!isNewMode || apiKeyId) return;
    const keys = availableApiKeys ?? [];
    if (keys.length === 0) return;
    const def = [...keys].sort(
      (a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""),
    )[0];
    if (def) setApiKeyId(def.id);
  }, [isNewMode, apiKeyId, availableApiKeys]);

  // Default the model for a NEW agent heuristically (templates deliberately don't
  // bake a model — it's provider-coupled). Adopt the model from an existing agent
  // that uses the SAME key (same provider → guaranteed-valid), most-recent wins.
  // Never overrides an explicit choice or a model from duplicate-from.
  useEffect(() => {
    if (!isNewMode || profileModel || !apiKeyId) return;
    const onSameKey = (existingProfiles ?? []).filter((p) => p.api_key_id === apiKeyId && p.model);
    if (onSameKey.length === 0) return;
    const ref = [...onSameKey].sort(
      (a, b) => (b.last_used_at ?? b.created_at).localeCompare(a.last_used_at ?? a.created_at),
    )[0];
    if (ref?.model) setProfileModel(ref.model);
  }, [isNewMode, apiKeyId, profileModel, existingProfiles]);

  // Add one or more domains (Enter, comma, blur, or pasted "a.com, b.com").
  // Splits on commas/whitespace, trims, dedupes — case-insensitively, since the
  // proxy matches case-insensitively.
  function addEgressDomains(raw: string) {
    const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setEgressDomains((prev) => {
      const seen = new Set(prev.map((d) => d.toLowerCase()));
      const merged = [...prev];
      for (const p of parts) {
        if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); merged.push(p); }
      }
      return merged;
    });
    setEgressInput("");
  }

  // The committed pills PLUS any text still sitting in the input — so a typed-
  // but-not-Entered domain isn't silently dropped on Save.
  function resolvedEgressDomains(): string[] {
    const pending = egressInput.trim();
    if (!pending) return egressDomains;
    const seen = new Set(egressDomains.map((d) => d.toLowerCase()));
    const extra = pending.split(/[\s,]+/).map((s) => s.trim())
      .filter((p) => p && !seen.has(p.toLowerCase()));
    return [...egressDomains, ...extra];
  }

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name, slug: slug.trim() || undefined,
        api_key_id: apiKeyId || null, model: profileModel || undefined, effort: effort || undefined,
        // When "Allow all egress" is on, keep the entered domains alongside "*"
        // (which still means bypass) so unchecking later restores them instead
        // of silently losing them across a save/reload.
        default_tools: tools,
        default_egress_domains: allowAllEgress
          ? [...new Set(["*", ...resolvedEgressDomains()])]
          : resolvedEgressDomains(),
        claude_md: claudeMd.trim() || "", mcp_servers: mcpServers,
        agent_ids: agentIds, skill_ids: skillIds, platform_capabilities: platformCaps, git_provider_ids: gitProviderIds,
        container_image: containerImage || undefined,
        setup_commands: setupCommands.trim() ? setupCommands.split("\n").map((s) => s.trim()).filter(Boolean) : [],
        persistent_sessions: persistentSessions,
        // Only admins may set docker_access; omit it for others so the backend
        // gate doesn't reject an unrelated edit of a profile that already has it.
        docker_access: isAdmin ? dockerAccess : undefined,
        memory_limit: memoryLimit || null,
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

      // Under enforcement, egress changes only apply to NEW sessions — a running
      // workspace keeps the network rules it was created with (incl. when
      // TIGHTENING). If egress changed and this agent has live sessions, nudge
      // the user to restart them instead of silently navigating away.
      const enforced = !!(window as unknown as { __VONZIO_EGRESS_ENFORCEMENT?: boolean }).__VONZIO_EGRESS_ENFORCEMENT;
      const egressDidChange = egressKey(allowAllEgress, allowAllEgress ? [] : resolvedEgressDomains()) !== initialEgressKey;
      if (editingId && enforced && egressDidChange) {
        try {
          const { workspaces } = await fetchWorkspaces();
          const live = workspaces.filter((w) => w.profile_id === editingId && w.container_id && !w.archived).length;
          if (live > 0) { setEgressNudge(live); setSaving(false); return; }
        } catch { /* nudge is best-effort — fall through to navigate */ }
      }
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

  async function handleUploadSkill(file: File) {
    setUploadingSkill(true);
    setError("");
    try {
      const created = (await uploadSkillFile(file)) as { id?: string };
      if (created?.id) setSkillIds((prev) => prev.includes(created.id!) ? prev : [...prev, created.id!]);
      await refetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload skill");
    } finally {
      setUploadingSkill(false);
      if (skillFileRef.current) skillFileRef.current.value = "";
    }
  }

  const tabs: TabDef[] = [
    { value: "overview", label: "Overview" },
    { value: "tools", label: "Tools & MCP" },
    { value: "extensions", label: "Knowledge & subagents" },
    { value: "network", label: "Advanced" },
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
    ? `Edit · ${name || "agent"}`
    : duplicatedFrom
      ? `Clone of ${duplicatedFrom}`
      : seededFrom
        ? `New · ${seededFrom}`
        : "New agent";

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
            <Button size="sm" onClick={handleSave} disabled={saving || profileModel.trim() === ""}>
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
        {seededFrom && (
          <div style={{ background: "var(--vz-sodium-08)", border: "1px solid var(--vz-sodium-25)", borderRadius: "var(--vz-radius-md)", padding: 12, fontSize: 12.5, color: "var(--vz-sodium)", fontFamily: "var(--vz-font-mono)" }}>
            Started from the <strong>{seededFrom}</strong> template. Review the API key, adjust anything, then save.
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

              <Panel title="System prompt (CLAUDE.md)">
                <Field label="Instructions" hint="Appended to every run. Defines the agent's identity and standing orders.">
                  <Textarea value={claudeMd} onChange={(e) => setClaudeMd(e.target.value)} placeholder="You are a senior engineer who…" rows={10} />
                </Field>
              </Panel>

              <Panel title="Model">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="API key">
                    <Select
                      options={apiKeyOptions}
                      value={apiKeyId}
                      onChange={(v) => {
                        const oldKey = (availableApiKeys ?? []).find((k) => k.id === apiKeyId);
                        const newKey = (availableApiKeys ?? []).find((k) => k.id === v);
                        // Models are provider-specific — carrying e.g. gpt-5.4
                        // over to an Anthropic key shows a stale, invalid pick
                        // (and a phantom "legacy" row). Clear it whenever the
                        // provider changes; keep it across same-provider keys.
                        if (newKey?.provider !== oldKey?.provider) setProfileModel("");
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
                          apiKeyId={apiKeyId || null}
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
              <Panel title="Knowledge">
                <KnowledgeSection profileId={editingId} />
              </Panel>
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
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={skillFileRef}
                      type="file"
                      accept=".zip,.md,.markdown"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadSkill(f); }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Upload size={12} />}
                      disabled={uploadingSkill}
                      onClick={() => skillFileRef.current?.click()}
                    >
                      {uploadingSkill ? "Uploading…" : "Upload .zip / .md"}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setNewSkillOpen(true)}>
                      New skill
                    </Button>
                  </div>
                }
              >
                <ChecklistRows
                  items={availableSkills ?? []}
                  selectedIds={skillIds}
                  onChange={setSkillIds}
                  emptyText="No skills yet — upload a .zip bundle or create one."
                />
              </Panel>
              <AgentSecretsPanel profileId={editingId} />
            </div>
          )}

          {activeTab === "network" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
              <Panel title="Runtime">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="Setup commands" hint="Run on container start. One per line.">
                    <Textarea value={setupCommands} onChange={(e) => setSetupCommands(e.target.value)} placeholder="npm install" rows={3} />
                  </Field>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <Checkbox checked={persistentSessions} onChange={setPersistentSessions}>Persistent sessions</Checkbox>
                    <Checkbox checked={memoryEnabled} onChange={setMemoryEnabled}>Agent memory</Checkbox>
                  </div>
                  <Field label="Workspace memory" hint={`RAM ceiling for this agent's container. Raise it for heavy builds or compose stacks. Default ${memDefault}; applies immediately to running workspaces (no restart).`}>
                    <Select
                      options={[
                        { value: "", label: `Default (${memDefault})` },
                        ...memSizes.map((s) => ({ value: s, label: s })),
                      ]}
                      value={memoryLimit}
                      onChange={setMemoryLimit}
                    />
                  </Field>
                  {availableImages && availableImages.length > 0 && (
                    <Field label="Container image" hint="Most agents run on the default. Pick another to customize.">
                      <Select
                        options={[
                          { value: "", label: "Default (vonzio-agent:latest)" },
                          ...availableImages.map((img) => {
                            const ref = `${img.name}:${img.tag}`;
                            return { value: ref, label: ref };
                          }),
                        ]}
                        value={containerImage}
                        onChange={setContainerImage}
                      />
                    </Field>
                  )}
                  {isAdmin && (
                    <Field
                      label="Docker access"
                      hint="Let this agent run docker / docker compose in a nested daemon. Requires DOCKER_ACCESS_MODE set on the host and a docker-capable container image (e.g. vonzio-agent:dind). Forces allow-all egress for the workspace (no proxy/VPN)."
                    >
                      <Checkbox checked={dockerAccess} onChange={setDockerAccess}>Enable Docker-in-Docker</Checkbox>
                    </Field>
                  )}
                </div>
              </Panel>

              <Panel title="Platform capabilities">
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ fontSize: 12, color: "var(--vz-muted)", margin: 0 }}>
                    Powerful/destructive platform tools this agent may call via the built-in vonzio MCP. Off by default — enable only what you trust this agent to do autonomously.
                  </p>
                  {PLATFORM_CAPABILITY_GROUPS.map((cap) => (
                    <Checkbox
                      key={cap.group}
                      checked={platformCaps.includes(cap.group)}
                      onChange={(on) =>
                        setPlatformCaps((prev) => on ? [...new Set([...prev, cap.group])] : prev.filter((g) => g !== cap.group))
                      }
                    >
                      <span style={{ fontWeight: 500 }}>{cap.label}</span>
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--vz-muted)" }}>{cap.description}</span>
                    </Checkbox>
                  ))}
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
                        <Field label="Max rounds" hint="Continuation rounds before stopping">
                          <Input type="number" min={1} max={200} value={String(maxContinuations)} onChange={(e) => setMaxContinuations(parseInt(e.target.value) || 5)} />
                        </Field>
                        <Field label="Budget cap (USD)" hint="Empty = no cap">
                          <Input type="number" step="0.1" min={0} value={continuationBudgetUsd} onChange={(e) => setContinuationBudgetUsd(e.target.value)} placeholder="No limit" />
                        </Field>
                      </>
                    )}
                  </div>
                  <Checkbox checked={autoContinue} onChange={setAutoContinue}>Run until done (autonomous goal mode)</Checkbox>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--vz-muted)" }}>
                    Keep working until an independent judge confirms the goal is met (or a round/budget limit is hit) — not just until the turn limit. This is the default for the chat composer's “Run until done” toggle, which can override it per message.
                  </p>
                </div>
              </Panel>

              <Panel title="Network egress">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {egressEnforced ? (
                    <>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                        <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
                          <ShieldCheck size={18} style={{ flexShrink: 0, marginTop: 1, color: allowAllEgress ? "var(--vz-muted-2)" : "var(--vz-ok)" }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--vz-ink)" }}>
                              Restrict network egress{" "}
                              <span style={{ fontWeight: 400, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", fontSize: 11 }}>recommended</span>
                            </div>
                            <div style={{ fontSize: 12, color: "var(--vz-muted)", marginTop: 3, lineHeight: 1.5 }}>
                              {allowAllEgress
                                ? "Off — the agent can reach any host on the internet."
                                : "On — the agent reaches only the model endpoint and the domains below; everything else is blocked (including shell commands like curl)."}
                            </div>
                          </div>
                        </div>
                        <Toggle checked={!allowAllEgress} onChange={(v) => setAllowAllEgress(!v)} aria-label="Restrict network egress" />
                      </div>
                      {!allowAllEgress && (
                    <Field label="Allowed domains" hint="Type a domain and press Enter or comma to add it.">
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
                          if ((e.key === "Enter" || e.key === ",") && egressInput.trim()) {
                            e.preventDefault();
                            addEgressDomains(egressInput);
                          }
                        }}
                        onBlur={() => addEgressDomains(egressInput)}
                        placeholder="github.com"
                      />
                    </Field>
                      )}
                    </>
                  ) : (
                    <div style={{ display: "flex", gap: 10, fontSize: 12.5, color: "var(--vz-muted)", lineHeight: 1.5 }}>
                      <Globe size={16} style={{ flexShrink: 0, marginTop: 1, color: "var(--vz-muted-2)" }} />
                      <span>
                        Network egress isn’t enforced on this server, so per-agent restrictions don’t apply — agents can reach any host. An operator can enable enforcement with <code style={{ fontFamily: "var(--vz-font-mono)" }}>EGRESS_ENFORCEMENT=1</code>.
                      </span>
                    </div>
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

      <Modal
        open={egressNudge !== null}
        onClose={() => navigate("/agents")}
        title="Network rules saved — restart to apply"
        description="Egress changes take effect on new sessions only."
        footer={
          <Button size="sm" onClick={() => navigate("/agents")}>Got it</Button>
        }
      >
        <p style={{ fontSize: 13, color: "var(--vz-ink-2)", lineHeight: 1.5, margin: 0 }}>
          {egressNudge} running workspace{egressNudge === 1 ? "" : "s"} for this agent
          {egressNudge === 1 ? " keeps" : " keep"} the network rules
          {egressNudge === 1 ? " it was" : " they were"} started with — including a
          tighter allowlist. Start a new workspace, or restart a running one, for the
          updated egress to apply.
        </p>
      </Modal>
    </div>
  );
}


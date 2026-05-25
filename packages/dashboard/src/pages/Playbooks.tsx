import { useState, type ReactNode } from "react";
import { Play, Pause, Trash2, Plus, RotateCw, Eye, Clock } from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import {
  fetchPlaybooks,
  createPlaybook,
  updatePlaybook,
  deletePlaybook,
  triggerPlaybook,
  fetchPlaybookRuns,
  fetchPlaybookRun,
  fetchAllPlaybookRuns,
  fetchProfiles,
  fetchTelegramBots,
  type Playbook,
  type PlaybookRun,
  type PlaybookChainConfig,
  type ActivityLogEntry,
  type ProfileSummary,
  type TelegramBot,
} from "../api/client.js";
import {
  PageHeader,
  PageBody,
  Button,
  Field,
  Input,
  Textarea,
  Select,
  Checkbox,
  Pill,
  Badge,
  DataTable,
  Modal,
  EmptyState,
  type DataColumn,
} from "../brand/components.js";
import { formatDate } from "../lib/utils.js";

type RunStatus = PlaybookRun["status"];
type Decision = PlaybookRun["decision_result"];

const statusTone: Record<RunStatus, "ok" | "warn" | "fail" | "default"> = {
  queued: "default",
  running: "warn",
  completed: "ok",
  failed: "fail",
  cancelled: "default",
};

function StatusPill({ status }: { status: RunStatus }) {
  return <Pill tone={statusTone[status] === "default" ? undefined : statusTone[status]} dot={status === "running"}>{status}</Pill>;
}

function DecisionPill({ result }: { result?: Decision }) {
  if (!result || result === "skipped") {
    return <span style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", fontSize: 11 }}>—</span>;
  }
  return <Pill tone={result === "pass" ? "ok" : "fail"}>{result}</Pill>;
}

function formatToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (tool === "Bash" && obj.command) return String(obj.command).slice(0, 120);
  if (tool === "Read" && obj.file_path) return String(obj.file_path);
  if (tool === "Write" && obj.file_path) return String(obj.file_path);
  if (tool === "Edit" && obj.file_path) return String(obj.file_path);
  if (tool === "Grep" && obj.pattern) return `/${obj.pattern}/`;
  if (tool === "Glob" && obj.pattern) return String(obj.pattern);
  if (tool === "WebFetch" && obj.url) return String(obj.url).slice(0, 80);
  return "";
}

function ActivityEntry({ entry }: { entry: ActivityLogEntry }) {
  if (entry.type === "text") {
    return (
      <div
        style={{
          fontSize: 13,
          color: "var(--vz-ink-3)",
          whiteSpace: "pre-wrap",
          paddingLeft: 10,
          borderLeft: "2px solid var(--vz-border)",
          lineHeight: 1.5,
        }}
      >
        {entry.text}
      </div>
    );
  }
  if (entry.type === "tool_use") {
    const inputSummary = entry.input ? formatToolInput(entry.tool ?? "", entry.input) : "";
    return (
      <div
        style={{
          fontFamily: "var(--vz-font-mono)",
          fontSize: 12,
          background: "var(--vz-mute)",
          border: "1px solid var(--vz-border)",
          borderRadius: "var(--vz-radius-sm)",
          padding: "4px 8px",
          color: "var(--vz-muted)",
        }}
      >
        <span style={{ color: "var(--vz-sodium)", fontWeight: 600 }}>{entry.tool}</span>
        {inputSummary && <span style={{ marginLeft: 6 }}>{inputSummary}</span>}
      </div>
    );
  }
  if (entry.type === "tool_result") {
    return (
      <div
        style={{
          fontFamily: "var(--vz-font-mono)",
          fontSize: 12,
          color: "var(--vz-muted)",
          background: "var(--vz-mute)",
          opacity: 0.85,
          borderRadius: "var(--vz-radius-sm)",
          padding: "4px 8px",
          maxHeight: 96,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {entry.output?.slice(0, 500)}
      </div>
    );
  }
  return null;
}

const triggerOptions = [
  { value: "cron", label: "Cron Schedule" },
  { value: "interval", label: "Interval" },
  { value: "manual", label: "Manual Only" },
  { value: "webhook", label: "Webhook" },
];

const notifyOptions = [
  { value: "none", label: "Never" },
  { value: "completion", label: "On Completion" },
  { value: "failure", label: "On Failure" },
  { value: "both", label: "Always" },
];

const criterionTypeOptions = [
  { value: "contains", label: "Result contains" },
  { value: "not_contains", label: "Result excludes" },
  { value: "cost_under", label: "Cost under ($)" },
  { value: "turns_under", label: "Turns under" },
  { value: "chains_under", label: "Chains under" },
];

function isTextCriterion(type: string): boolean {
  return type === "contains" || type === "not_contains";
}

export function Playbooks() {
  const { data: playbooks, loading, refetch } = useApi<Playbook[]>(() => fetchPlaybooks());
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const { data: telegramBotsRes } = useApi<{ bots: TelegramBot[] }>(() => fetchTelegramBots());
  const telegramBots = (telegramBotsRes?.bots ?? []).filter((b) => b.linked);
  const { data: allRuns, refetch: refetchRuns } = useApi<PlaybookRun[]>(() => fetchAllPlaybookRuns());
  const [error, setError] = useState("");

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [profileId, setProfileId] = useState("");
  const [schedule, setSchedule] = useState("");
  const [maxChains, setMaxChains] = useState(5);
  const [budgetCap, setBudgetCap] = useState(10);
  const [maxTurnsPerChain, setMaxTurnsPerChain] = useState<number | "">("");
  const [enabled, setEnabled] = useState(false);
  const [triggerType, setTriggerType] = useState("cron");
  const [intervalSeconds, setIntervalSeconds] = useState<number | "">("");
  const [notifyOn, setNotifyOn] = useState("none");
  const [notifySlack, setNotifySlack] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [selectedTelegramBotIds, setSelectedTelegramBotIds] = useState<string[]>([]);
  const [allowedTools, setAllowedTools] = useState("");
  const [timeoutPerChain, setTimeoutPerChain] = useState<number | "">("");
  const [webhookToken, setWebhookToken] = useState("");
  const [successCriteria, setSuccessCriteria] = useState<Array<{ type: string; field?: string; value: string | number }>>([]);

  // Drawers / modals
  const [runsModalOpen, setRunsModalOpen] = useState(false);
  const [selectedPlaybook, setSelectedPlaybook] = useState<Playbook | null>(null);
  const [playbookRuns, setPlaybookRuns] = useState<PlaybookRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<PlaybookRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const resetForm = () => {
    setName(""); setDescription(""); setPrompt(""); setProfileId(""); setSchedule("");
    setMaxChains(5); setBudgetCap(10); setMaxTurnsPerChain(""); setEnabled(false);
    setTriggerType("cron"); setIntervalSeconds(""); setNotifyOn("none");
    setNotifySlack(false); setNotifyEmail(false); setSelectedTelegramBotIds([]); setAllowedTools("");
    setTimeoutPerChain(""); setWebhookToken(""); setSuccessCriteria([]);
    setEditingId(null); setShowForm(false); setError("");
  };

  const openCreate = () => { resetForm(); setShowForm(true); };

  const openEdit = (pb: Playbook) => {
    setEditingId(pb.id);
    setName(pb.name);
    setDescription(pb.description);
    setPrompt(pb.prompt);
    setProfileId(pb.profile_id);
    setSchedule(pb.schedule);
    setMaxChains(pb.chain_config.max_chains);
    setBudgetCap(pb.chain_config.budget_cap_usd);
    setMaxTurnsPerChain(pb.chain_config.max_turns_per_chain ?? "");
    setEnabled(pb.enabled);
    setTriggerType(pb.trigger_type ?? "cron");
    setIntervalSeconds(pb.interval_seconds ?? "");
    setNotifyOn(pb.notify_on ?? "none");
    setNotifySlack(pb.notification_channels?.includes("slack") ?? false);
    setNotifyEmail(pb.notification_channels?.includes("email") ?? false);
    setSelectedTelegramBotIds(
      (pb.notification_channels ?? [])
        .filter((c) => c.startsWith("telegram:"))
        .map((c) => c.slice("telegram:".length)),
    );
    setAllowedTools(pb.chain_config.allowed_tools?.join(", ") ?? "");
    setTimeoutPerChain(pb.chain_config.timeout_per_chain_seconds ?? "");
    setWebhookToken(pb.webhook_token ?? "");
    setSuccessCriteria(pb.success_criteria ?? []);
    setShowForm(true);
  };

  const openRuns = async (pb: Playbook) => {
    setSelectedPlaybook(pb);
    try {
      const runs = await fetchPlaybookRuns(pb.id);
      setPlaybookRuns(runs);
    } catch { setPlaybookRuns([]); }
    setRunsModalOpen(true);
  };

  const openRunDetail = async (run: PlaybookRun) => {
    setSelectedRun(run);
    setLoadingRun(true);
    try {
      const full = await fetchPlaybookRun(run.id);
      setSelectedRun(full);
    } catch { /* keep partial */ }
    setLoadingRun(false);
  };

  const handleSave = async () => {
    setError("");
    try {
      const channels: string[] = [];
      if (notifySlack) channels.push("slack");
      if (notifyEmail) channels.push("email");
      // Filter selected bot ids against currently-visible (linked) bots so a stale id from
      // a since-unlinked bot — invisible in the UI — can't be re-saved and rejected by the
      // server, which would soft-lock the form.
      const visibleBotIds = new Set(telegramBots.map((b) => b.id));
      for (const botId of selectedTelegramBotIds) {
        if (visibleBotIds.has(botId)) channels.push(`telegram:${botId}`);
      }

      const chainConfig: Partial<PlaybookChainConfig> = {
        max_chains: maxChains,
        budget_cap_usd: budgetCap,
        ...(maxTurnsPerChain ? { max_turns_per_chain: Number(maxTurnsPerChain) } : {}),
        ...(allowedTools.trim() ? { allowed_tools: allowedTools.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
        ...(timeoutPerChain ? { timeout_per_chain_seconds: Number(timeoutPerChain) } : {}),
      };
      const payload = {
        name, description, prompt, profile_id: profileId, schedule,
        chain_config: chainConfig, enabled,
        trigger_type: triggerType,
        interval_seconds: intervalSeconds || undefined,
        notify_on: notifyOn,
        notification_channels: channels,
        ...(successCriteria.length > 0 ? { success_criteria: successCriteria } : {}),
      };
      if (editingId) {
        await updatePlaybook(editingId, payload);
      } else {
        if (!name || !profileId || !prompt) { setError("Name, profile, and prompt are required"); return; }
        if (triggerType === "cron" && !schedule) { setError("Cron schedule is required"); return; }
        if (triggerType === "interval" && !intervalSeconds) { setError("Interval is required"); return; }
        await createPlaybook({ ...payload, profile_id: profileId });
      }
      resetForm();
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePlaybook(id);
      setConfirmDeleteId(null);
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const handleToggleEnabled = async (pb: Playbook) => {
    try {
      await updatePlaybook(pb.id, { enabled: !pb.enabled });
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to toggle"); }
  };

  const handleRunNow = async (pb: Playbook) => {
    try {
      await triggerPlaybook(pb.id);
      refetch();
      refetchRuns();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to trigger"); }
  };

  const profileName = (id: string) => profiles?.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  // ─── Tables ────────────────────────────────────────────────────────────
  const recentRunCols: DataColumn<PlaybookRun>[] = [
    {
      key: "playbook",
      label: "Playbook",
      render: (r) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{r.playbook_name ?? r.playbook_id.slice(0, 8)}</span>,
    },
    { key: "status", label: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "decision", label: "Decision", render: (r) => <DecisionPill result={r.decision_result} /> },
    {
      key: "chains",
      label: "Chains",
      numeric: true,
      render: (r) => `${r.chain_count} / ${r.total_turns}t`,
    },
    {
      key: "cost",
      label: "Cost",
      numeric: true,
      align: "right",
      render: (r) => `$${r.total_cost_usd.toFixed(2)}`,
    },
    {
      key: "started",
      label: "Started",
      render: (r) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatDate(r.started_at)}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "60px",
      align: "right",
      render: (r) => (
        <button
          type="button"
          className="vz-action-btn"
          title="View details"
          onClick={(e) => { e.stopPropagation(); openRunDetail(r); }}
        >
          <Eye size={14} />
        </button>
      ),
    },
  ];

  const playbookCols: DataColumn<Playbook>[] = [
    {
      key: "name",
      label: "Name",
      render: (pb) => (
        <div>
          <div style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{pb.name}</div>
          {pb.description && (
            <div style={{ fontSize: 12, color: "var(--vz-muted-2)", marginTop: 2, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pb.description}
            </div>
          )}
        </div>
      ),
    },
    { key: "profile", label: "Profile", render: (pb) => <Badge>{profileName(pb.profile_id)}</Badge> },
    {
      key: "trigger",
      label: "Trigger",
      render: (pb) => (
        <span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 12, color: "var(--vz-ink-3)" }}>
          {pb.trigger_type === "cron" && pb.schedule}
          {pb.trigger_type === "interval" && `every ${pb.interval_seconds}s`}
          {pb.trigger_type === "manual" && <span style={{ color: "var(--vz-muted-2)" }}>manual</span>}
          {pb.trigger_type === "webhook" && <span style={{ color: "var(--vz-muted-2)" }}>webhook</span>}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (pb) => <Pill tone={pb.enabled ? "ok" : undefined} dot={pb.enabled}>{pb.enabled ? "Active" : "Paused"}</Pill>,
    },
    {
      key: "last_run",
      label: "Last Run",
      render: (pb) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{pb.last_run_at ? formatDate(pb.last_run_at) : "Never"}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "140px",
      align: "right",
      render: (pb) => (
        <div style={{ display: "inline-flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="vz-action-btn" title="Run now" onClick={() => handleRunNow(pb)}>
            <Play size={14} />
          </button>
          <button
            type="button"
            className="vz-action-btn"
            title={pb.enabled ? "Pause" : "Enable"}
            onClick={() => handleToggleEnabled(pb)}
          >
            {pb.enabled ? <Pause size={14} /> : <RotateCw size={14} />}
          </button>
          <button type="button" className="vz-action-btn" title="View runs" onClick={() => openRuns(pb)}>
            <Eye size={14} />
          </button>
          <button
            type="button"
            className="vz-action-btn vz-action-btn--danger"
            title="Delete"
            onClick={() => setConfirmDeleteId(pb.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Playbooks"
        title="Scheduled & autonomous tasks"
        lede="Define prompts that run on a schedule, an interval, a webhook, or by hand — with budget, turn, and tool caps."
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            New playbook
          </Button>
        }
      />

      <PageBody>
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

        {allRuns && allRuns.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <DataTable
              title="Recent runs"
              count={allRuns.length}
              columns={recentRunCols}
              rows={allRuns.slice(0, 5)}
              rowKey={(r) => r.id}
              onRowClick={openRunDetail}
            />
          </div>
        )}

        <DataTable
          title="Playbooks"
          count={playbooks?.length}
          columns={playbookCols}
          rows={playbooks ?? []}
          rowKey={(pb) => pb.id}
          onRowClick={openEdit}
          loading={loading}
          emptyState={
            <EmptyState
              icon={<Clock size={22} />}
              title="No playbooks yet"
              description="Create a playbook to run prompts on a schedule, an interval, a webhook, or by hand."
              action={
                <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>
                  New playbook
                </Button>
              }
            />
          }
        />

        {/* Create / edit form */}
        <Modal
          open={showForm}
          onClose={resetForm}
          size="lg"
          dismissable={false}
          title={editingId ? "Edit playbook" : "New playbook"}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
              <Button size="sm" onClick={handleSave}>{editingId ? "Update" : "Create"}</Button>
            </>
          }
        >
          {error && (
            <div style={{ fontSize: 13, color: "var(--vz-fail)", marginBottom: 12, fontFamily: "var(--vz-font-mono)" }}>{error}</div>
          )}
          <FormStack>
            <Row>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly Dep Check" />
              </Field>
              <Field label="Agent profile">
                <Select
                  options={(profiles ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  value={profileId}
                  onChange={setProfileId}
                  placeholder="Select profile…"
                />
              </Field>
            </Row>
            <Field label="Description" hint="What this playbook does (optional)">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Prompt" hint="The task prompt sent to the agent">
              <Textarea value={prompt} rows={6} onChange={(e) => setPrompt(e.target.value)} />
            </Field>

            <SectionLabel>Trigger</SectionLabel>
            <Row>
              <Field label="Type">
                <Select options={triggerOptions} value={triggerType} onChange={setTriggerType} />
              </Field>
              {triggerType === "cron" && (
                <Field label="Schedule (cron)">
                  <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 2 * * *" />
                </Field>
              )}
              {triggerType === "interval" && (
                <Field label="Interval (seconds)">
                  <Input
                    type="number"
                    value={String(intervalSeconds)}
                    onChange={(e) => setIntervalSeconds(e.target.value ? Number(e.target.value) : "")}
                    placeholder="3600"
                  />
                </Field>
              )}
              {triggerType === "webhook" && editingId && (
                <Field label="Webhook URL">
                  <Input value={`${window.location.origin}/v1/webhook/playbook/${webhookToken}`} readOnly />
                </Field>
              )}
            </Row>

            <SectionLabel>Chain config</SectionLabel>
            <Row>
              <Field label="Max chains" hint="server range: 1–20">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={String(maxChains)}
                  onChange={(e) => setMaxChains(Number(e.target.value))}
                />
              </Field>
              <Field label="Budget cap ($)" hint="server range: 0.1–100">
                <Input
                  type="number"
                  min={0.1}
                  max={100}
                  step={0.1}
                  value={String(budgetCap)}
                  onChange={(e) => setBudgetCap(Number(e.target.value))}
                />
              </Field>
            </Row>
            <Row>
              <Field label="Turns per chain" hint="server range: 5–200 (default 200)">
                <Input
                  type="number"
                  min={5}
                  max={200}
                  value={String(maxTurnsPerChain)}
                  onChange={(e) => setMaxTurnsPerChain(e.target.value ? Number(e.target.value) : "")}
                />
              </Field>
              <Field label="Chain timeout (s)" hint="default: 3600">
                <Input
                  type="number"
                  min={60}
                  value={String(timeoutPerChain)}
                  onChange={(e) => setTimeoutPerChain(e.target.value ? Number(e.target.value) : "")}
                />
              </Field>
            </Row>
            <Field label="Allowed tools" hint="Comma-separated. Leave empty for profile defaults.">
              <Input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} />
            </Field>

            <SectionLabel>Notifications</SectionLabel>
            <Row>
              <Field label="Notify on">
                <Select options={notifyOptions} value={notifyOn} onChange={setNotifyOn} />
              </Field>
              {notifyOn !== "none" && (
                <Field label="Channels">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
                    <div style={{ display: "flex", gap: 16 }}>
                      <Checkbox checked={notifySlack} onChange={setNotifySlack}>Slack</Checkbox>
                      <Checkbox checked={notifyEmail} onChange={setNotifyEmail}>Email</Checkbox>
                    </div>
                    {telegramBots.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, color: "var(--vz-muted-2)", marginBottom: 4 }}>
                          Telegram bots:
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 8 }}>
                          {telegramBots.map((bot) => {
                            const checked = selectedTelegramBotIds.includes(bot.id);
                            const label = bot.is_platform_owned
                              ? `@${bot.bot_username} (platform)`
                              : bot.bound_profile_name
                                ? `@${bot.bot_username} → ${bot.bound_profile_name}`
                                : `@${bot.bot_username}`;
                            return (
                              <Checkbox
                                key={bot.id}
                                checked={checked}
                                onChange={(v) => {
                                  setSelectedTelegramBotIds((prev) => {
                                    if (v) return prev.includes(bot.id) ? prev : [...prev, bot.id];
                                    return prev.filter((id) => id !== bot.id);
                                  });
                                }}
                              >
                                {label}
                              </Checkbox>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </Field>
              )}
            </Row>

            <SectionLabel>Success criteria</SectionLabel>
            {successCriteria.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--vz-muted-2)", margin: 0 }}>
                No criteria — decision will be skipped.
              </p>
            )}
            {successCriteria.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: "0 0 200px" }}>
                  <Select
                    options={criterionTypeOptions}
                    value={c.type}
                    onChange={(v) => {
                      const updated = [...successCriteria];
                      const text = isTextCriterion(v);
                      updated[i] = {
                        type: v,
                        ...(text ? { field: "result_summary" } : {}),
                        value: text ? "" : 0,
                      };
                      setSuccessCriteria(updated);
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Input
                    type={isTextCriterion(c.type) ? "text" : "number"}
                    value={String(c.value)}
                    placeholder={isTextCriterion(c.type) ? "pattern…" : "threshold"}
                    onChange={(e) => {
                      const updated = [...successCriteria];
                      const text = isTextCriterion(c.type);
                      updated[i] = { ...c, value: text ? e.target.value : Number(e.target.value) };
                      setSuccessCriteria(updated);
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="vz-action-btn vz-action-btn--danger"
                  onClick={() => setSuccessCriteria(successCriteria.filter((_, j) => j !== i))}
                  aria-label="Remove criterion"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setSuccessCriteria([...successCriteria, { type: "contains", field: "result_summary", value: "" }])
              }
            >
              + Add criterion
            </Button>

            <div style={{ borderTop: "1px solid var(--vz-border)", paddingTop: 14, marginTop: 4 }}>
              <Checkbox checked={enabled} onChange={setEnabled}>
                Enable (starts running on save)
              </Checkbox>
            </div>
          </FormStack>
        </Modal>

        {/* Run history list */}
        <Modal
          open={runsModalOpen}
          onClose={() => setRunsModalOpen(false)}
          size="lg"
          title={`Runs · ${selectedPlaybook?.name ?? ""}`}
        >
          {playbookRuns.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--vz-muted)" }}>No runs yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {playbookRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => openRunDetail(run)}
                  style={{
                    textAlign: "left",
                    padding: 14,
                    background: "var(--vz-mute)",
                    border: "1px solid var(--vz-border)",
                    borderRadius: "var(--vz-radius-lg)",
                    color: "var(--vz-ink)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <StatusPill status={run.status} />
                    <span style={{ fontSize: 11, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                      {formatDate(run.started_at)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>
                    {run.chain_count} chains · {run.total_turns} turns · ${run.total_cost_usd.toFixed(2)}
                  </div>
                  {run.result_summary && (
                    <p style={{ fontSize: 13, color: "var(--vz-ink-3)", marginTop: 6 }}>{run.result_summary}</p>
                  )}
                  {run.error && (
                    <p style={{ fontSize: 13, color: "var(--vz-fail)", marginTop: 6 }}>{run.error}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </Modal>

        {/* Run detail */}
        <Modal
          open={!!selectedRun}
          onClose={() => setSelectedRun(null)}
          size="xl"
          title={`Run · ${selectedRun?.playbook_name ?? ""}`}
        >
          {selectedRun && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusPill status={selectedRun.status} />
                  <DecisionPill result={selectedRun.decision_result} />
                </div>
                <span style={{ fontSize: 11, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                  {formatDate(selectedRun.started_at)}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "4px 12px",
                  fontSize: 13,
                  color: "var(--vz-ink-3)",
                  fontFamily: "var(--vz-font-mono)",
                }}
              >
                <span style={{ color: "var(--vz-muted-2)" }}>chains</span>
                <span>{selectedRun.chain_count} / {selectedRun.total_turns} turns</span>
                <span style={{ color: "var(--vz-muted-2)" }}>cost</span>
                <span>${selectedRun.total_cost_usd.toFixed(2)}</span>
                {selectedRun.finished_at && (
                  <>
                    <span style={{ color: "var(--vz-muted-2)" }}>finished</span>
                    <span>{formatDate(selectedRun.finished_at)}</span>
                  </>
                )}
              </div>

              {selectedRun.result_summary && (
                <div>
                  <SubLabel>Result</SubLabel>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--vz-ink-3)",
                      whiteSpace: "pre-wrap",
                      background: "var(--vz-mute)",
                      border: "1px solid var(--vz-border)",
                      borderRadius: "var(--vz-radius-md)",
                      padding: 12,
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {selectedRun.result_summary}
                  </p>
                </div>
              )}

              {selectedRun.error && (
                <div>
                  <SubLabel tone="fail">Error</SubLabel>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--vz-fail)",
                      whiteSpace: "pre-wrap",
                      background: "rgba(220, 38, 38, 0.08)",
                      border: "1px solid rgba(220, 38, 38, 0.25)",
                      borderRadius: "var(--vz-radius-md)",
                      padding: 12,
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {selectedRun.error}
                  </p>
                </div>
              )}

              {loadingRun && (
                <div style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                  loading activity…
                </div>
              )}
              {selectedRun.activity_log && selectedRun.activity_log.length > 0 && (
                <div>
                  <SubLabel>Activity ({selectedRun.activity_log.length} events)</SubLabel>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      maxHeight: "50vh",
                      overflowY: "auto",
                    }}
                  >
                    {selectedRun.activity_log.map((entry, i) => (
                      <ActivityEntry key={i} entry={entry} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>

        {/* Confirm delete */}
        <Modal
          open={!!confirmDeleteId}
          onClose={() => setConfirmDeleteId(null)}
          title="Delete playbook"
          description="Delete this playbook and all its run history? This cannot be undone."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>
                Delete
              </Button>
            </>
          }
        />
      </PageBody>
    </>
  );
}

// ─── Tiny layout helpers (page-local, not brand) ─────────────────────────
function FormStack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>;
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--vz-muted-2)",
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px solid var(--vz-border)",
      }}
    >
      {children}
    </div>
  );
}

function SubLabel({ children, tone }: { children: ReactNode; tone?: "fail" }) {
  return (
    <div
      style={{
        fontFamily: "var(--vz-font-mono)",
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: tone === "fail" ? "var(--vz-fail)" : "var(--vz-muted-2)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

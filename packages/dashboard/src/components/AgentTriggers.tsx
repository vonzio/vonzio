/**
 * Agent Triggers (feature 0027, phase 2 / "Live agents").
 *
 * Lets an agent run automatically — on a schedule, an interval, a webhook, or on
 * demand. This is the UI face of "operate a service": the agent becomes a Live
 * agent the moment it has an enabled trigger.
 *
 * Phase-1 reuse: a trigger IS a Playbook scoped to this agent (profile_id ===
 * agentId) — so we ride the existing, prod-running scheduler + ChainRunner +
 * runs/notifications engine with no new backend. The standalone Playbooks page
 * stays for power users / advanced config (chain limits, success criteria,
 * notification channels); this surface keeps the common case one form.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Play, Trash2, Clock, Repeat, Webhook, Hand, ExternalLink, Copy, Check } from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import {
  fetchPlaybooks, createPlaybook, updatePlaybook, deletePlaybook, triggerPlaybook,
  type Playbook,
} from "../api/client.js";
import { Panel, Field, Input, Select, Textarea, Button, Checkbox } from "../brand/components.js";
import { formatRelative } from "../lib/utils.js";
import type { TriggerType } from "@vonzio/shared";

const TYPE_META: Record<TriggerType, { label: string; icon: typeof Clock }> = {
  cron: { label: "Schedule (cron)", icon: Clock },
  interval: { label: "Every N minutes", icon: Repeat },
  webhook: { label: "Webhook", icon: Webhook },
  manual: { label: "Manual / on demand", icon: Hand },
};

function triggerSummary(t: Playbook): string {
  if (t.trigger_type === "cron") return `cron: ${t.schedule}`;
  if (t.trigger_type === "interval") return `every ${Math.round((t.interval_seconds ?? 3600) / 60)} min`;
  if (t.trigger_type === "webhook") return "on webhook call";
  return "manual only";
}

export function AgentTriggers({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const { data: all, loading, refetch } = useApi<Playbook[]>(() => fetchPlaybooks());
  const triggers = (all ?? []).filter((p) => p.profile_id === agentId);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<TriggerType>("cron");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [intervalMin, setIntervalMin] = useState("60");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim() || !prompt.trim()) { setError("Name and instructions are required."); return; }
    setSaving(true); setError("");
    try {
      await createPlaybook({
        name: name.trim(),
        profile_id: agentId,
        prompt: prompt.trim(),
        trigger_type: type,
        schedule: type === "cron" ? schedule.trim() : "",
        interval_seconds: type === "interval" ? Math.max(1, parseInt(intervalMin) || 60) * 60 : undefined,
        enabled: true,
      });
      setName(""); setPrompt(""); setCreating(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create trigger");
    } finally {
      setSaving(false);
    }
  }

  const webhookUrl = (t: Playbook) =>
    `${window.location.origin}/v1/webhook/playbook/${t.webhook_token}`;

  return (
    <Panel
      title="Triggers"
      action={
        !creating ? (
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => { setCreating(true); setError(""); }}>
            New trigger
          </Button>
        ) : undefined
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--vz-muted)" }}>
          Run this agent automatically — on a schedule, an interval, a webhook, or on demand. An enabled trigger makes it a live agent.
        </p>

        {creating && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, border: "1px solid var(--vz-border)", borderRadius: "var(--vz-radius-md)", background: "var(--vz-card)" }}>
            {error && <div style={{ fontSize: 12, color: "var(--vz-danger, #e5484d)" }}>{error}</div>}
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning digest" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="When">
                <Select
                  options={(Object.keys(TYPE_META) as TriggerType[]).map((k) => ({ value: k, label: TYPE_META[k].label }))}
                  value={type}
                  onChange={(v) => setType(v as TriggerType)}
                />
              </Field>
              {type === "cron" && (
                <Field label="Cron (UTC)" hint="5-field, e.g. 0 9 * * * = 9:00 daily">
                  <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * *" />
                </Field>
              )}
              {type === "interval" && (
                <Field label="Every (minutes)">
                  <Input type="number" min={1} value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
                </Field>
              )}
            </div>
            <Field label="Instructions" hint="What the agent should do each time this fires.">
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Summarize overnight support tickets and post the highlights." />
            </Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setError(""); }}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? "Adding…" : "Add trigger"}</Button>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 12, color: "var(--vz-muted)" }}>loading…</div>
        ) : triggers.length === 0 && !creating ? (
          <div style={{ fontSize: 12.5, color: "var(--vz-muted-2)" }}>No triggers yet — add one to run this agent automatically.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {triggers.map((t) => {
              const Icon = TYPE_META[t.trigger_type as TriggerType]?.icon ?? Clock;
              return (
                <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "11px 13px", border: "1px solid var(--vz-border)", borderRadius: "var(--vz-radius-md)", background: "var(--vz-card)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <Icon size={15} style={{ color: t.enabled ? "var(--vz-sodium)" : "var(--vz-muted-2)", flexShrink: 0 }} />
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>{triggerSummary(t)}</span>
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <Checkbox checked={t.enabled} onChange={async () => { await updatePlaybook(t.id, { enabled: !t.enabled }); refetch(); }}>Enabled</Checkbox>
                      <button type="button" title="Run now" onClick={async () => { await triggerPlaybook(t.id); refetch(); }} className="vz-action-btn"><Play size={13} /></button>
                      <button type="button" title="Delete" onClick={async () => { if (confirm(`Delete trigger "${t.name}"?`)) { await deletePlaybook(t.id); refetch(); } }} className="vz-action-btn"><Trash2 size={13} /></button>
                    </div>
                  </div>
                  {t.trigger_type === "webhook" && t.webhook_token && (
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(webhookUrl(t)); setCopied(t.id); setTimeout(() => setCopied(null), 1500); }}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, alignSelf: "flex-start", background: "none", border: 0, cursor: "pointer", padding: 0, fontSize: 11, fontFamily: "var(--vz-font-mono)", color: "var(--vz-muted)" }}
                      title="Copy webhook URL"
                    >
                      {copied === t.id ? <Check size={11} /> : <Copy size={11} />}
                      {webhookUrl(t)}
                    </button>
                  )}
                  <div style={{ fontSize: 11, color: "var(--vz-muted-2)" }}>
                    {t.last_run_at ? `Last run ${formatRelative(t.last_run_at)}` : "Not run yet"}
                    {t.enabled && t.next_run_at ? ` · next ${formatRelative(t.next_run_at)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={() => navigate("/playbooks")}
          style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: 0, cursor: "pointer", padding: 0, fontSize: 12, color: "var(--vz-muted)" }}
        >
          <ExternalLink size={12} /> Advanced options in Playbooks
        </button>
      </div>
    </Panel>
  );
}

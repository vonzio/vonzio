// Secrets section for the Agent edit page. Unlike skills/subagents (which are
// stored as id lists ON the profile), a secret owns the list of profiles it's
// scoped to — so attaching/detaching here updates the SECRET's profile_ids
// directly and takes effect immediately (not on profile save). Mirrors the
// look of the Skills/Subagents panels.
import { useState } from "react";
import { Plus, KeyRound, Globe, Loader2 } from "lucide-react";
import { Panel, Button, Field, Input } from "../brand/components.js";
import { useApi } from "../hooks/useApi.js";
import { fetchSecrets, createSecret, updateSecret, type UserSecret } from "../api/client.js";

export function AgentSecretsPanel({ profileId }: { profileId: string | null }) {
  const { data: secrets, refetch } = useApi<UserSecret[]>(() => fetchSecrets());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const newSecretAction = (
    <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => { setError(""); setCreating((v) => !v); }} disabled={!profileId}>
      New secret
    </Button>
  );

  if (!profileId) {
    return (
      <Panel title="Secrets">
        <div style={{ fontSize: 13, color: "var(--vz-muted)" }}>Save the agent first to attach secrets.</div>
      </Panel>
    );
  }

  const pid: string = profileId;
  const all = secrets ?? [];
  const agentScoped = all.filter((s) => s.scope === "agents");
  const globalSecrets = all.filter((s) => s.scope === "all");
  const attachedHere = (s: UserSecret) => (s.profile_ids ?? []).includes(pid);

  async function toggle(s: UserSecret) {
    const has = attachedHere(s);
    const next = has ? (s.profile_ids ?? []).filter((id) => id !== pid) : [...(s.profile_ids ?? []), pid];
    if (has && next.length === 0) {
      setError(`"${s.name}" is only scoped to this agent — change or delete it in Settings to avoid orphaning it.`);
      return;
    }
    setBusyId(s.id); setError("");
    try {
      await updateSecret(s.id, { scope: "agents", profile_ids: next });
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update secret");
    }
    setBusyId(null);
  }

  async function handleCreate() {
    if (!name.trim() || !value) { setError("Name and value are required"); return; }
    setSaving(true); setError("");
    try {
      await createSecret({ name: name.trim(), value, scope: "agents", profile_ids: [pid] });
      setName(""); setValue(""); setCreating(false);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create secret");
    }
    setSaving(false);
  }

  return (
    <Panel title="Secrets" action={newSecretAction}>
      {error && (
        <div className="mb-2 px-2.5 py-1.5 rounded-lg text-xs" style={{ background: "var(--vz-mute)", border: "1px solid var(--vz-fail)", color: "var(--vz-fail)" }}>
          {error}
        </div>
      )}

      {creating && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, marginBottom: 12, borderRadius: "var(--vz-radius-md)", background: "var(--vz-mute)", border: "1px solid var(--vz-border)" }}>
          <Field label="Name" hint="Exposed to this agent's container as an env var.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_API_KEY" />
          </Field>
          <Field label="Value" hint="Encrypted at rest; never shown again after saving.">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk_live_…" />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setName(""); setValue(""); }}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={saving || !name.trim() || !value}>
              {saving ? "Adding…" : "Add secret"}
            </Button>
          </div>
        </div>
      )}

      {agentScoped.length === 0 && globalSecrets.length === 0 && !creating && (
        <div style={{ fontSize: 13, color: "var(--vz-muted)" }}>
          No secrets yet — add one above, or create user-wide secrets in Settings.
        </div>
      )}

      {/* Agent-scoped secrets: toggle whether THIS agent is included. */}
      {agentScoped.map((s) => {
        const checked = attachedHere(s);
        const others = (s.profile_ids ?? []).filter((id) => id !== profileId).length;
        return (
          <label
            key={s.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", cursor: busyId === s.id ? "wait" : "pointer", borderBottom: "1px solid var(--vz-border)" }}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={busyId === s.id}
              onChange={() => toggle(s)}
            />
            <KeyRound className="w-3.5 h-3.5" style={{ color: "var(--vz-sodium)", flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13, color: "var(--vz-ink)" }} className="font-mono">{s.name}</span>
            {busyId === s.id && <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--vz-muted-2)" }} />}
            {checked && others > 0 && (
              <span style={{ fontSize: 11, color: "var(--vz-muted-2)" }}>+{others} other{others === 1 ? "" : "s"}</span>
            )}
          </label>
        );
      })}

      {/* Global secrets are inherited by every agent; shown read-only here. */}
      {globalSecrets.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontFamily: "var(--vz-font-mono)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)", marginBottom: 6 }}>
            Available to all agents
          </div>
          {globalSecrets.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", fontSize: 12.5, color: "var(--vz-muted)" }}>
              <Globe className="w-3 h-3" style={{ color: "var(--vz-muted-2)", flexShrink: 0 }} />
              <span className="font-mono">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

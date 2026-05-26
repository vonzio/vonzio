import { useState } from "react";
import { Trash2, Lock, Plus } from "lucide-react";
import { useApi } from "../../../hooks/useApi.js";
import {
  fetchSecrets, createSecret, updateSecret, deleteSecret, type UserSecret, type SecretScope,
  fetchProfiles, type ProfileSummary,
} from "../../../api/client.js";
import {
  Button, Field, Input,
  Modal, EmptyState, DataTable,
  type DataColumn,
} from "../../../brand/components.js";
import { formatDate } from "../../../lib/utils.js";
import { ErrorBanner, ScopePicker } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// Secrets
// ───────────────────────────────────────────────────────────────────

export function SecretSection() {
  const { data: secrets, loading, refetch } = useApi<UserSecret[]>(() => fetchSecrets());
  const { data: agentProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretScope, setSecretScope] = useState<SecretScope>("all");
  const [secretProfileIds, setSecretProfileIds] = useState<string[]>([]);
  const [nameError, setNameError] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<UserSecret | null>(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editScope, setEditScope] = useState<SecretScope>("all");
  const [editProfileIds, setEditProfileIds] = useState<string[]>([]);
  const [editNameError, setEditNameError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const validateName = (name: string, setErr: (m: string) => void): boolean => {
    if (!name) { setErr("Name is required"); return false; }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      setErr("Uppercase letters, digits, and underscores only (e.g. DATABASE_URL)");
      return false;
    }
    setErr(""); return true;
  };

  const resetForm = () => {
    setSecretName(""); setSecretValue("");
    setSecretScope("all"); setSecretProfileIds([]);
    setNameError(""); setShowForm(false);
  };
  const openEditor = (s: UserSecret) => {
    setEditingSecret(s);
    setEditName(s.name); setEditValue("");
    setEditScope(s.scope); setEditProfileIds(s.profile_ids);
    setEditNameError("");
    setEditorOpen(true);
  };
  const closeEditor = () => { setEditorOpen(false); setEditingSecret(null); };

  const handleCreate = async () => {
    setError("");
    if (!validateName(secretName, setNameError)) return;
    if (!secretValue) { setError("Value is required"); return; }
    if (secretScope === "agents" && secretProfileIds.length === 0) {
      setError("Select at least one agent or switch to 'All agents'"); return;
    }
    try {
      await createSecret({
        name: secretName,
        value: secretValue,
        scope: secretScope,
        profile_ids: secretScope === "agents" ? secretProfileIds : undefined,
      });
      resetForm(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to create secret"); }
  };

  const handleEditorSave = async () => {
    if (!editingSecret) return;
    setError("");
    if (editName !== editingSecret.name && !validateName(editName, setEditNameError)) return;
    if (editScope === "agents" && editProfileIds.length === 0) {
      setError("Select at least one agent or switch to 'All agents'"); return;
    }
    try {
      const body: { name?: string; value?: string; scope?: SecretScope; profile_ids?: string[] } = {};
      if (editName !== editingSecret.name) body.name = editName;
      if (editValue && editValue !== "••••••••") body.value = editValue;
      if (editScope !== editingSecret.scope) body.scope = editScope;
      if (editScope === "agents") {
        const a = [...editProfileIds].sort();
        const b = [...editingSecret.profile_ids].sort();
        if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
          body.profile_ids = editProfileIds;
        }
      } else if (editingSecret.scope === "agents") {
        // scope flipped 'agents' -> 'all'; clear profile_ids explicitly.
        body.profile_ids = [];
      }
      if (Object.keys(body).length > 0) await updateSecret(editingSecret.id, body);
      closeEditor(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to update"); }
  };

  const handleDelete = async (id: string) => {
    setError("");
    try { await deleteSecret(id); setConfirmDeleteId(null); closeEditor(); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const cols: DataColumn<UserSecret>[] = [
    { key: "name", label: "Name", render: (s) => <code style={{ fontFamily: "var(--vz-font-mono)", fontSize: 12.5, color: "var(--vz-ink)" }}>{s.name}</code> },
    { key: "value", label: "Value", render: () => <span style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>••••••••</span> },
    {
      key: "scope",
      label: "Scope",
      render: (s) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>
          {s.scope === "all"
            ? "all agents"
            : `${s.profile_ids.length} agent${s.profile_ids.length === 1 ? "" : "s"}`}
        </span>
      ),
    },
    { key: "created", label: "Created", render: (s) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatDate(s.created_at)}</span> },
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
          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id); }}
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
        title="Secrets"
        count={secrets?.length}
        columns={cols}
        rows={secrets ?? []}
        rowKey={(s) => s.id}
        onRowClick={openEditor}
        loading={loading}
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add secret</Button>}
        emptyState={
          <EmptyState
            icon={<Lock size={20} />}
            title="No secrets yet"
            description="Add encrypted environment variables — they're injected into your agent containers at runtime."
            action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add secret</Button>}
          />
        }
      />

      <Modal
        open={showForm}
        onClose={resetForm}
        size="md"
        dismissable={false}
        title="Add secret"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Add secret</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name" error={nameError} hint="Uppercase letters, digits, and underscores. Used as the env var name in containers.">
            <Input
              value={secretName}
              onChange={(e) => { setSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")); setNameError(""); }}
              placeholder="DATABASE_URL"
            />
          </Field>
          <Field label="Value">
            <Input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="Enter secret value" />
          </Field>
          <ScopePicker
            scope={secretScope}
            setScope={setSecretScope}
            profileIds={secretProfileIds}
            setProfileIds={setSecretProfileIds}
            agentProfiles={agentProfiles ?? []}
          />
        </div>
      </Modal>

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        size="md"
        dismissable={false}
        title={editingSecret ? `Edit · ${editingSecret.name}` : "Edit secret"}
        footer={
          <>
            {editingSecret && (
              <button
                type="button"
                onClick={() => setConfirmDeleteId(editingSecret.id)}
                style={{ background: "none", border: 0, color: "var(--vz-fail)", fontSize: 12.5, cursor: "pointer", marginRight: "auto", padding: 0, fontFamily: "inherit" }}
              >
                Delete
              </button>
            )}
            <Button variant="ghost" size="sm" onClick={closeEditor}>Cancel</Button>
            <Button size="sm" onClick={handleEditorSave}>Save</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name" error={editNameError}>
            <Input
              value={editName}
              onChange={(e) => { setEditName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")); setEditNameError(""); }}
            />
          </Field>
          <Field label="Value" hint="Leave blank to keep the current value.">
            <Input type="password" value={editValue} onChange={(e) => setEditValue(e.target.value)} placeholder="••••••••" />
          </Field>
          <ScopePicker
            scope={editScope}
            setScope={setEditScope}
            profileIds={editProfileIds}
            setProfileIds={setEditProfileIds}
            agentProfiles={agentProfiles ?? []}
          />
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete secret?"
        description="Agents using this secret will lose access to this environment variable."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}>Delete</Button>
          </>
        }
      />
    </>
  );
}

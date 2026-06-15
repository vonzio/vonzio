import { useState } from "react";
import { Trash2, Shield, Plus, Copy, Check } from "lucide-react";
import { useApi } from "../../../hooks/useApi.js";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard.js";
import {
  fetchApiTokens,
  createApiToken,
  updateApiToken,
  deleteApiToken,
  type ApiTokenInfo,
} from "../../../api/admin.js";
import {
  fetchProfiles, type ProfileSummary,
} from "../../../api/client.js";
import {
  Card, Button, Field, Input,
  Modal, EmptyState, DataTable, Banner, Pill,
  type DataColumn,
} from "../../../brand/components.js";
import { formatDate } from "../../../lib/utils.js";
import { ErrorBanner } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// API tokens
// ───────────────────────────────────────────────────────────────────

export function ApiTokenSection() {
  const { data: keys, loading, refetch } = useApi<ApiTokenInfo[]>(() => fetchApiTokens());
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [rpm, setRpm] = useState("60");
  const [newKeyResult, setNewKeyResult] = useState<{ name: string; token: string } | null>(null);
  const [copied, copyToken] = useCopyToClipboard();
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const resetForm = () => {
    setNewName(""); setSelectedProfileIds([]); setRpm("60");
    setEditingId(null); setShowForm(false);
  };

  const openEdit = (k: ApiTokenInfo) => {
    setEditingId(k.id); setNewName(k.name);
    setSelectedProfileIds([...k.allowed_profile_ids]); setRpm(String(k.rate_limit_rpm));
    setShowForm(true);
  };

  // New tokens default to ALL profiles allowed (the common case); the user can
  // deselect to narrow scope.
  const openCreate = () => {
    setEditingId(null); setNewName(""); setRpm("60");
    setSelectedProfileIds(profiles?.map((p) => p.id) ?? []);
    setShowForm(true);
  };

  const handleSave = async () => {
    setError("");
    try {
      if (editingId) {
        await updateApiToken(editingId, {
          name: newName, allowed_profile_ids: selectedProfileIds, rate_limit_rpm: Number(rpm) || 60,
        });
        resetForm(); refetch();
      } else {
        const result = await createApiToken({
          name: newName, allowed_profile_ids: selectedProfileIds, rate_limit_rpm: Number(rpm) || 60,
        });
        setNewKeyResult({ name: result.name, token: result.caller_key });
        resetForm(); refetch();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
  };

  const toggleProfile = (id: string) => {
    setSelectedProfileIds((prev) => prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]);
  };

  const handleDelete = async (id: string) => {
    setError("");
    try { await deleteApiToken(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const cols: DataColumn<ApiTokenInfo>[] = [
    { key: "name", label: "Name", render: (k) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{k.name}</span> },
    {
      key: "profiles",
      label: "Profiles",
      render: (k) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {k.allowed_profile_ids.length ? k.allowed_profile_ids.map((pid) => (
            <button
              key={pid}
              type="button"
              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(pid); }}
              title="Click to copy"
              style={{ background: "none", border: 0, padding: 0, fontFamily: "var(--vz-font-mono)", fontSize: 11, color: "var(--vz-muted)", cursor: "pointer", textAlign: "left" }}
            >
              {pid}
            </button>
          )) : <span style={{ color: "var(--vz-muted-2)" }}>—</span>}
        </div>
      ),
    },
    {
      key: "rpm",
      label: "Rate limit",
      width: "100px",
      numeric: true,
      render: (k) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{k.rate_limit_rpm} rpm</span>,
    },
    {
      key: "created",
      label: "Created",
      render: (k) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatDate(k.created_at)}</span>,
    },
    {
      key: "lastUsed",
      label: "Last used",
      render: (k) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{k.last_used_at ? formatDate(k.last_used_at) : <span style={{ color: "var(--vz-muted-2)" }}>never</span>}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "60px",
      align: "right",
      render: (k) => (
        <button
          type="button"
          className="vz-action-btn vz-action-btn--danger"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(k.id); }}
        >
          <Trash2 size={13} />
        </button>
      ),
    },
  ];

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {newKeyResult && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Pill tone="ok" dot>Token created</Pill>
            <span style={{ fontSize: 13, color: "var(--vz-muted)" }}>{newKeyResult.name}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code
              style={{
                flex: 1, minWidth: 0,
                fontFamily: "var(--vz-font-mono)", fontSize: 12.5,
                background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
                borderRadius: "var(--vz-radius-sm)", padding: "8px 10px",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: "var(--vz-ink)",
              }}
              title={newKeyResult.token}
            >
              {newKeyResult.token}
            </code>
            <Button
              variant="ghost" size="sm"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => copyToken(newKeyResult.token)}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div style={{ marginTop: 12 }}>
            <Banner>Copy and store this token now — it won't be shown again.</Banner>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => setNewKeyResult(null)}>Done</Button>
          </div>
        </Card>
      )}

      <DataTable
        title="API tokens"
        count={keys?.length}
        columns={cols}
        rows={keys ?? []}
        rowKey={(k) => k.id}
        onRowClick={openEdit}
        loading={loading}
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>Create token</Button>}
        emptyState={
          <EmptyState
            icon={<Shield size={20} />}
            title="No API tokens yet"
            description="Create a token for the CLI or programmatic access."
            action={<Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>Create token</Button>}
          />
        }
      />

      <Modal
        open={showForm}
        onClose={resetForm}
        size="lg"
        dismissable={false}
        title={editingId ? `Edit · ${newName}` : "Create API token"}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={!newName || selectedProfileIds.length === 0}>
              {editingId ? "Save" : "Create token"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. my-app" />
            </Field>
            <Field label="Rate limit (rpm)">
              <Input type="number" value={rpm} onChange={(e) => setRpm(e.target.value)} />
            </Field>
          </div>
          <Field label="Allowed profiles" hint="The token can only run agents under one of these profiles.">
            {profiles?.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {profiles.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleProfile(c.id)}
                    className="vz-chip"
                    data-active={selectedProfileIds.includes(c.id) ? "true" : undefined}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: "var(--vz-muted-2)" }}>No profiles available — create one first.</span>
            )}
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete API token?"
        description="Any client (CLI, integration) using this token will stop working."
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

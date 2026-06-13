import { useState, useEffect } from "react";
import { Trash2, KeyRound, CheckCircle, Plus } from "lucide-react";
import { useApi } from "../../../hooks/useApi.js";
import {
  createAnthropicKey,
  updateAnthropicKey,
  deleteAnthropicKey,
  validateAnthropicKey,
  type AnthropicKeyInfo,
} from "../../../api/admin.js";
import {
  fetchUserAnthropicKeys, createUserAnthropicKey, updateUserAnthropicKey, deleteUserAnthropicKey,
  validateUserAnthropicKey,
} from "../../../api/client.js";
import {
  Button, Field, Input, Select, Checkbox, Toggle,
  Badge, Modal, EmptyState, DataTable,
  type DataColumn, type SelectOption,
} from "../../../brand/components.js";
import { PROVIDER_CATALOG, providerInfoByProvider } from "@vonzio/shared";
import { formatDate } from "../../../lib/utils.js";
import { authClient } from "../../../lib/auth-client.js";
import { useUser } from "../../../contexts/UserContext.js";
import { ErrorBanner, SubLabel } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// Anthropic API Keys (BYOK)
// ───────────────────────────────────────────────────────────────────

export function AnthropicKeySection() {
  const currentUser = useUser();
  const isAdmin = currentUser.role === "admin";
  const { data: keys, loading, refetch } = useApi<AnthropicKeyInfo[]>(() => fetchUserAnthropicKeys() as Promise<AnthropicKeyInfo[]>, []);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<AnthropicKeyInfo | null>(null);
  const [keyName, setKeyName] = useState("");
  const [provider, setProvider] = useState<"api_key" | "ollama" | "openai">("api_key");
  const [apiKey, setApiKey] = useState("");
  // OpenAI-compatible endpoint override; only sent/shown for the openai
  // provider, and tucked behind an "Advanced" disclosure so the common case
  // (OpenAI itself) stays clean. Auto-expanded when editing a key that has one.
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // "Test connection" result for the add/edit dialog (validate without saving).
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [isSharedKey, setIsSharedKey] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAdmin) return;
    authClient.admin.listUsers({ query: { limit: 100 } }).then((res) => {
      if (res.data?.users) {
        const users = res.data.users as Array<{ id: string; name: string; email: string }>;
        setAllUsers(users);
        const map: Record<string, string> = {};
        for (const u of users) map[u.id] = u.name;
        setUserNames(map);
      }
    }).catch(() => {});
  }, [isAdmin]);

  const resetForm = () => { setKeyName(""); setProvider("api_key"); setApiKey(""); setBaseUrl(""); setShowAdvanced(false); setTestResult(null); setIsSharedKey(false); setShowForm(false); };

  const openEditor = (k: AnthropicKeyInfo) => {
    setEditingKey(k); setKeyName(k.name); setProvider(k.provider as typeof provider);
    setApiKey(""); setBaseUrl(k.base_url ?? ""); setShowAdvanced(!!k.base_url); setTestResult(null); setSharedWith(k.allowed_user_ids ?? []); setEditorOpen(true);
  };
  const closeEditor = () => { setEditorOpen(false); setEditingKey(null); setTestResult(null); };

  // Validate the credential without saving. Sends the entered values plus the
  // editing id (so a masked key falls back to the stored secret server-side).
  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const result = await validateUserAnthropicKey({
        provider,
        api_key: apiKey || undefined,
        base_url: provider === "openai" ? (baseUrl.trim() || null) : undefined,
        id: editingKey?.id,
      });
      setTestResult(result);
    } catch (e) {
      setTestResult({ valid: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleCreate = async () => {
    setError("");
    try {
      const body: Record<string, unknown> = {
        name: keyName, provider,
        api_key: apiKey,
      };
      if (provider === "openai") body.base_url = baseUrl.trim() || null;
      if (isAdmin) {
        body.shared = isSharedKey;
        await createAnthropicKey(body as Parameters<typeof createAnthropicKey>[0]);
      } else {
        await createUserAnthropicKey(body as Parameters<typeof createUserAnthropicKey>[0]);
      }
      resetForm(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
  };

  const handleEditorSave = async () => {
    if (!editingKey) return;
    setError("");
    try {
      const body: Record<string, unknown> = { name: keyName };
      if (apiKey && apiKey !== "••••••••") {
        body.api_key = apiKey;
      }
      if (editingKey.provider === "openai") body.base_url = baseUrl.trim() || null;
      if (!editingKey.user_id) body.allowed_user_ids = sharedWith;
      if (isAdmin) await updateAnthropicKey(editingKey.id, body as Parameters<typeof updateAnthropicKey>[1]);
      else await updateUserAnthropicKey(editingKey.id, body as Record<string, unknown>);
      closeEditor(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
  };

  const handleDelete = async (id: string) => {
    setError("");
    try {
      if (isAdmin) await deleteAnthropicKey(id); else await deleteUserAnthropicKey(id);
      setConfirmDeleteId(null); closeEditor(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const handleValidate = async (id: string) => {
    setError("");
    try {
      const result = await validateAnthropicKey(id);
      if (result.valid) alert("API key is valid!");
      else setError(`Validation failed: ${result.error}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Validation failed"); }
  };

  const ownerLabel = (k: AnthropicKeyInfo) => {
    if (!k.user_id) return "shared";
    return userNames[k.user_id] ?? k.user_id.slice(0, 8);
  };

  // SaaS-only: an api_keys row with org_id set is the materialization
  // of a team-shared org_credential. The current user has access via
  // org membership, not ownership — managed by the org owner under
  // /org/settings → Credentials. Hide editor / delete affordances.
  const isTeamKey = (k: AnthropicKeyInfo): boolean => Boolean(k.org_id) && !k.user_id;

  const cols: DataColumn<AnthropicKeyInfo>[] = [
    {
      key: "name",
      label: "Name",
      render: (k) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{k.name}</span>
          {isTeamKey(k) && <Badge tone="accent">Team</Badge>}
        </span>
      ),
    },
    ...(isAdmin ? [{
      key: "owner",
      label: "Owner",
      render: (k: AnthropicKeyInfo) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>
          {ownerLabel(k)}
        </span>
      ),
    }] : []),
    { key: "provider", label: "Provider", render: (k) => <Badge>{k.provider}</Badge> },
    ...(isAdmin ? [{
      key: "shared",
      label: "Shared with",
      render: (k: AnthropicKeyInfo) => (
        <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>
          {!k.user_id && k.allowed_user_ids?.length
            ? `${k.allowed_user_ids.length} user${k.allowed_user_ids.length > 1 ? "s" : ""}`
            : k.user_id ? "—" : "none"}
        </span>
      ),
    }] : []),
    {
      key: "created",
      label: "Created",
      render: (k) => <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{formatDate(k.created_at)}</span>,
    },
    {
      key: "_actions",
      label: "",
      width: "80px",
      align: "right",
      render: (k) => (
        <div style={{ display: "inline-flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          {isAdmin && (
            <button type="button" className="vz-action-btn" title="Validate" onClick={() => handleValidate(k.id)}>
              <CheckCircle size={13} />
            </button>
          )}
          {/* Team-shared keys: never owned by this user. Editing /
              deleting happens in /org/settings → Credentials. */}
          {!isTeamKey(k) && (isAdmin || k.user_id === currentUser.id) && (
            <button type="button" className="vz-action-btn vz-action-btn--danger" title="Delete" onClick={() => setConfirmDeleteId(k.id)}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Provider list + per-provider labels/placeholders come from the shared
  // PROVIDER_CATALOG so this editor stays in lockstep with the onboarding
  // wizard and the first-key modal.
  const providerOpts: SelectOption[] = PROVIDER_CATALOG.map((p) => ({
    value: p.provider,
    label: p.label,
  }));
  const createMeta = providerInfoByProvider(provider);

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
      <DataTable
        title="Keys"
        count={keys?.length}
        columns={cols}
        rows={keys ?? []}
        rowKey={(k) => k.id}
        onRowClick={(k) => { if (!isTeamKey(k) && (isAdmin || k.user_id === currentUser.id)) openEditor(k); }}
        loading={loading}
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add key</Button>}
        emptyState={
          <EmptyState
            icon={<KeyRound size={20} />}
            title="No API keys yet"
            description="Add an Anthropic API key, subscription token, or Ollama Cloud key to get started."
            action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add key</Button>}
          />
        }
      />

      <Modal
        open={showForm}
        onClose={resetForm}
        size="md"
        dismissable={false}
        title="Add API key"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Add key</Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Production key" />
          </Field>
          <Field label="Provider">
            <Select options={providerOpts} value={provider} onChange={(v) => setProvider(v as typeof provider)} />
          </Field>
          <Field label={createMeta.fieldLabel}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={createMeta.placeholder}
            />
          </Field>
          {provider === "openai" && (showAdvanced ? (
            <Field label="Base URL" hint="OpenAI-compatible endpoint (OpenRouter, Azure, vLLM, LM Studio). Leave blank for OpenAI.">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com" />
            </Field>
          ) : (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              style={{ alignSelf: "flex-start", background: "none", border: 0, color: "var(--vz-muted)", fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
            >
              + Advanced — use a custom OpenAI-compatible endpoint
            </button>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing || (!editingKey && !apiKey.trim())}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
            {testResult && (
              <span style={{ fontSize: 12.5, color: testResult.valid ? "var(--vz-ok, #2faa6a)" : "var(--vz-fail)" }}>
                {testResult.valid ? "✓ Valid — provider reachable" : `✗ ${testResult.error ?? "Invalid key"}`}
              </span>
            )}
          </div>
          {isAdmin && (
            <Toggle checked={isSharedKey} onChange={setIsSharedKey}>
              Shared key — available to users you grant access to
            </Toggle>
          )}
        </div>
      </Modal>

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        size="lg"
        dismissable={false}
        title={editingKey ? `Edit · ${editingKey.name}` : "Edit key"}
        footer={
          <>
            {editingKey && (
              <button
                type="button"
                onClick={() => setConfirmDeleteId(editingKey.id)}
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
          <Field label="Name">
            <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </Field>
          <div>
            <SubLabel>Provider</SubLabel>
            <span style={{ fontSize: 13, color: "var(--vz-ink-3)" }}>
              {providerInfoByProvider((editingKey?.provider ?? "api_key") as typeof provider).label}
            </span>
          </div>
          <Field label={providerInfoByProvider((editingKey?.provider ?? "api_key") as typeof provider).fieldLabel} hint="Leave blank to keep the current value.">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
          </Field>
          {editingKey?.provider === "openai" && (showAdvanced ? (
            <Field label="Base URL" hint="OpenAI-compatible endpoint (OpenRouter, Azure, vLLM, LM Studio). Leave blank for OpenAI.">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com" />
            </Field>
          ) : (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              style={{ alignSelf: "flex-start", background: "none", border: 0, color: "var(--vz-muted)", fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
            >
              + Advanced — use a custom OpenAI-compatible endpoint
            </button>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
            {testResult && (
              <span style={{ fontSize: 12.5, color: testResult.valid ? "var(--vz-ok, #2faa6a)" : "var(--vz-fail)" }}>
                {testResult.valid ? "✓ Valid — provider reachable" : `✗ ${testResult.error ?? "Invalid key"}`}
              </span>
            )}
          </div>
          {isAdmin && editingKey && editingKey.user_id && (
            <div>
              <SubLabel>Owner</SubLabel>
              <span style={{ fontSize: 13, color: "var(--vz-ink-3)" }}>
                {userNames[editingKey.user_id] ?? editingKey.user_id}
              </span>
            </div>
          )}
          {isAdmin && editingKey && !editingKey.user_id && (
            <div>
              <SubLabel>Share with users</SubLabel>
              <div style={{ fontSize: 12, color: "var(--vz-muted-2)", marginBottom: 8 }}>
                Pick which users can use this key in their agent profiles.
              </div>
              <div style={{
                border: "1px solid var(--vz-border)",
                borderRadius: "var(--vz-radius-md)",
                maxHeight: 200, overflowY: "auto",
                background: "var(--vz-mute)",
              }}>
                {allUsers.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--vz-muted-2)", padding: 12, margin: 0 }}>loading users…</p>
                ) : (
                  allUsers.map((u) => (
                    <Checkbox
                      key={u.id}
                      checked={sharedWith.includes(u.id)}
                      onChange={(checked) => {
                        if (checked) setSharedWith((prev) => [...prev, u.id]);
                        else setSharedWith((prev) => prev.filter((id) => id !== u.id));
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontWeight: 500 }}>{u.name}</span>
                        <span style={{ fontSize: 11.5, color: "var(--vz-muted-2)" }}>{u.email}</span>
                      </span>
                    </Checkbox>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete API key?"
        description="Profiles using this key will stop working until you swap them to another key."
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

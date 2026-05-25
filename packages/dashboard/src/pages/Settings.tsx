import React, { useState, useEffect, useCallback, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  GitBranch, Copy, Trash2, KeyRound, CheckCircle, Plug, UserCircle, Link2, Unlink,
  Lock, Shield, Plus,
} from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import {
  fetchApiTokens,
  createApiToken,
  updateApiToken,
  deleteApiToken,
  type ApiTokenInfo,
  createAnthropicKey,
  updateAnthropicKey,
  deleteAnthropicKey,
  validateAnthropicKey,
  type AnthropicKeyInfo,
} from "../api/admin.js";
import {
  fetchGitOAuthConfig, getGitOAuthAuthorizeUrl,
  fetchSlackConfig, getSlackAuthorizeUrl,
  fetchGmailConfig, getGmailAuthorizeUrl,
  fetchTelegramConfig, fetchTelegramBots, connectTelegram, connectTelegramPlatform, disconnectTelegram, regenerateTelegramLinkCode, updateTelegramBotBinding,
  fetchTellerConfig, submitTellerEnrollment, type TellerConfigInfo,
  type TelegramBot, type TelegramConfigInfo,
  fetchIntegrations, deleteIntegration, createIntegration, updateIntegration, testIntegration,
  type Integration,
  fetchUserAnthropicKeys, createUserAnthropicKey, updateUserAnthropicKey, deleteUserAnthropicKey,
  fetchUserGitProviders, createUserGitProvider, updateUserGitProvider, deleteUserGitProvider,
  type GitProviderInfo,
  fetchSecrets, createSecret, updateSecret, deleteSecret, type UserSecret, type SecretScope,
  fetchProfiles, type ProfileSummary,
  type GitOAuthConfig,
} from "../api/client.js";
import {
  PageHeader, PageBody, Tabs, Card, Button, Field, Input, Select, Checkbox, Radio, Toggle,
  Pill, Badge, Modal, EmptyState, DataTable,
  type DataColumn, type SelectOption,
} from "../brand/components.js";
import { formatDate, hasFlag } from "../lib/utils.js";
import { openTellerConnect } from "../lib/teller-connect.js";
import { authClient } from "../lib/auth-client.js";
import { useUser } from "../contexts/UserContext.js";

const tabDefs = [
  { value: "account", label: "Account" },
  { value: "apikeys", label: "Keys" },
  { value: "secrets", label: "Secrets" },
  { value: "git", label: "Git" },
  { value: "integrations", label: "Integrations" },
  { value: "apitokens", label: "API tokens" },
];

const tabLedes: Record<string, string> = {
  account: "Profile, password, and connected social accounts.",
  apikeys: "Anthropic API credentials used by your agent profiles. Bring your own.",
  secrets: "Encrypted environment variables injected into agent containers at runtime.",
  git: "Git credentials for cloning private repos. Wire one to a profile to give it write access.",
  integrations: "Notifications, chat, and read-only data sources your agents can use.",
  apitokens: "API tokens for programmatic access — embed widgets, CLI, or external integrations.",
};

export function Settings() {
  const validIds = tabDefs.map((t) => t.value);
  const hashTab = window.location.hash.slice(1);
  const [activeTab, setActiveTabRaw] = useState(validIds.includes(hashTab) ? hashTab : "account");

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
  }, [validIds.join(",")]);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Account & access" lede={tabLedes[activeTab]} />
      <PageBody>
        <Tabs tabs={tabDefs} value={activeTab} onChange={setActiveTab} />
        <div style={{ marginTop: 24 }}>
          {activeTab === "account" && <AccountSection />}
          {activeTab === "apikeys" && <AnthropicKeySection />}
          {activeTab === "secrets" && <SecretSection />}
          {activeTab === "git" && <GitSection />}
          {activeTab === "integrations" && <IntegrationSection />}
          {activeTab === "apitokens" && <ApiTokenSection />}
        </div>
      </PageBody>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Account
// ───────────────────────────────────────────────────────────────────

interface AccountInfo { id: string; accountId: string; providerId: string; }

function AccountSection() {
  const user = useUser();
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authProviders, setAuthProviders] = useState<{ google?: boolean; github?: boolean }>({});

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c) => {
      if (c.authProviders) setAuthProviders(c.authProviders);
    }).catch(() => {});
    authClient.listAccounts().then((res) => {
      if (res.data) setAccounts(res.data as unknown as AccountInfo[]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const isLinked = (provider: string) => accounts.some((a) => a.providerId === provider);
  const handleLink = async (provider: "google" | "github") => {
    await authClient.linkSocial({ provider, callbackURL: "/settings#account" });
  };
  const handleUnlink = async (providerId: string) => {
    setError("");
    try {
      const account = accounts.find((a) => a.providerId === providerId);
      if (!account) return;
      await authClient.unlinkAccount({ providerId });
      setAccounts((prev) => prev.filter((a) => a.providerId !== providerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unlink");
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: 16,
      }}
    >
      <Card>
        <SubLabel>Profile</SubLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ProfileRow label="Name" value={user.name ?? "—"} />
          <ProfileRow label="Email" value={user.email ?? "—"} />
          <ProfileRow
            label="Role"
            value={<Pill tone={user.role === "admin" ? "info" : undefined}>{user.role}</Pill>}
          />
        </div>
      </Card>
      <ChangePasswordCard />

      {(authProviders.google || authProviders.github) && (
        <Card>
          <SubLabel>Connected accounts</SubLabel>
          <div style={{ fontSize: 12.5, color: "var(--vz-muted)", marginBottom: 12, marginTop: -4 }}>
            Link external accounts for faster sign-in.
          </div>
          {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
          {loading ? (
            <div style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>loading…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {authProviders.google && (
                <ProviderRow
                  name="Google"
                  icon={<GoogleIcon />}
                  linked={isLinked("google")}
                  onLink={() => handleLink("google")}
                  onUnlink={() => handleUnlink("google")}
                />
              )}
              {authProviders.github && (
                <ProviderRow
                  name="GitHub"
                  icon={<GithubIcon />}
                  linked={isLinked("github")}
                  onLink={() => handleLink("github")}
                  onUnlink={() => handleUnlink("github")}
                />
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 13, color: "var(--vz-muted)" }}>{label}</span>
      <span style={{ fontSize: 14, color: "var(--vz-ink-3)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function ProviderRow({
  name, icon, linked, onLink, onUnlink,
}: { name: string; icon: ReactNode; linked: boolean; onLink: () => void; onUnlink: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      padding: "10px 0", borderBottom: "1px solid var(--vz-border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          {icon}
        </span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--vz-ink)" }}>{name}</div>
          <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
            {linked ? "connected" : "not connected"}
          </div>
        </div>
      </div>
      {linked ? (
        <Button variant="danger-ghost" size="sm" icon={<Unlink size={13} />} onClick={onUnlink}>
          Disconnect
        </Button>
      ) : (
        <Button variant="ghost" size="sm" icon={<Link2 size={13} />} onClick={onLink}>
          Connect
        </Button>
      )}
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setError(""); setSuccess(""); setLoading(true);
    const { error: err } = await authClient.changePassword({ currentPassword, newPassword });
    setLoading(false);
    if (err) {
      setError(err.message ?? "Failed to change password");
    } else {
      setSuccess("Password updated.");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    }
  }

  return (
    <Card>
      <SubLabel>Password</SubLabel>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Current password">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </Field>
        <Field label="New password" hint="Minimum 8 characters">
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </Field>
        {error && <p style={{ fontSize: 12.5, color: "var(--vz-fail)", margin: 0 }}>{error}</p>}
        {success && <p style={{ fontSize: 12.5, color: "var(--vz-ok)", margin: 0 }}>{success}</p>}
        <div>
          <Button type="submit" size="sm" disabled={loading}>{loading ? "Updating…" : "Change password"}</Button>
        </div>
      </form>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────
// Anthropic API Keys (BYOK)
// ───────────────────────────────────────────────────────────────────

function AnthropicKeySection() {
  const currentUser = useUser();
  const isAdmin = currentUser.role === "admin";
  const ollamaEnabled = (window as { __VONZIO_OLLAMA_ENABLED?: boolean }).__VONZIO_OLLAMA_ENABLED && hasFlag(currentUser.feature_flags, "ollama");
  const { data: keys, loading, refetch } = useApi<AnthropicKeyInfo[]>(() => fetchUserAnthropicKeys() as Promise<AnthropicKeyInfo[]>, []);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<AnthropicKeyInfo | null>(null);
  const [keyName, setKeyName] = useState("");
  const [provider, setProvider] = useState<"api_key" | "subscription_token" | "ollama">("api_key");
  const [apiKey, setApiKey] = useState("");
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

  const resetForm = () => { setKeyName(""); setProvider("api_key"); setApiKey(""); setIsSharedKey(false); setShowForm(false); };

  const openEditor = (k: AnthropicKeyInfo) => {
    setEditingKey(k); setKeyName(k.name); setProvider(k.provider as typeof provider);
    setApiKey(""); setSharedWith(k.allowed_user_ids ?? []); setEditorOpen(true);
  };
  const closeEditor = () => { setEditorOpen(false); setEditingKey(null); };

  const handleCreate = async () => {
    setError("");
    try {
      const body: Record<string, unknown> = {
        name: keyName, provider,
        ...(provider === "subscription_token" ? { auth_token: apiKey } : { api_key: apiKey }),
      };
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
        if (provider === "subscription_token") body.auth_token = apiKey;
        else body.api_key = apiKey;
      }
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

  const cols: DataColumn<AnthropicKeyInfo>[] = [
    {
      key: "name",
      label: "Name",
      render: (k) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{k.name}</span>,
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
          {(isAdmin || k.user_id === currentUser.id) && (
            <button type="button" className="vz-action-btn vz-action-btn--danger" title="Delete" onClick={() => setConfirmDeleteId(k.id)}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const providerOpts: SelectOption[] = [
    { value: "api_key", label: "Anthropic API key" },
    { value: "subscription_token", label: "Subscription token" },
    ...(ollamaEnabled ? [{ value: "ollama", label: "Ollama Cloud" }] : []),
  ];

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
      <DataTable
        title="Keys"
        count={keys?.length}
        columns={cols}
        rows={keys ?? []}
        rowKey={(k) => k.id}
        onRowClick={(k) => { if (isAdmin || k.user_id === currentUser.id) openEditor(k); }}
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
          <Field label={provider === "ollama" ? "Ollama API key" : provider === "api_key" ? "Anthropic API key" : "Auth token"}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === "ollama" ? "Enter Ollama key" : provider === "api_key" ? "sk-ant-api03-…" : "Enter token"}
            />
          </Field>
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
              {editingKey?.provider === "ollama" ? "Ollama Cloud" : editingKey?.provider === "api_key" ? "Anthropic API key" : "Subscription token"}
            </span>
          </div>
          <Field label={editingKey?.provider === "ollama" ? "Ollama API key" : editingKey?.provider === "api_key" ? "API key" : "Auth token"} hint="Leave blank to keep the current value.">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
          </Field>
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

// ───────────────────────────────────────────────────────────────────
// Secrets
// ───────────────────────────────────────────────────────────────────

function ScopePicker({
  name = "secretScope",
  hint = "All agents: injected into every container. Specific: only the selected agents see it.",
  scope, setScope, profileIds, setProfileIds, agentProfiles,
}: {
  name?: string;
  hint?: string;
  scope: SecretScope;
  setScope: (s: SecretScope) => void;
  profileIds: string[];
  setProfileIds: (ids: string[]) => void;
  agentProfiles: ProfileSummary[];
}) {
  return (
    <Field label="Scope" hint={hint}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Radio
          name={name}
          checked={scope === "all"}
          onChange={(c) => { if (c) setScope("all"); }}
        >
          All agents
        </Radio>
        <Radio
          name={name}
          checked={scope === "agents"}
          onChange={(c) => { if (c) setScope("agents"); }}
        >
          Specific agents
        </Radio>
        {scope === "agents" && (
          <div
            style={{
              marginLeft: 24, marginTop: 4,
              display: "flex", flexDirection: "column", gap: 6,
              padding: 10,
              border: "1px solid var(--vz-border)",
              borderRadius: 6,
              background: "var(--vz-mute)",
              maxHeight: 200, overflowY: "auto",
            }}
          >
            {agentProfiles.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>No agents available.</span>
            ) : (
              agentProfiles.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={profileIds.includes(p.id)}
                  onChange={(checked) => {
                    if (checked) setProfileIds([...profileIds, p.id]);
                    else setProfileIds(profileIds.filter((id) => id !== p.id));
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {p.name}
                    {p.user_id == null && (
                      <span style={{ color: "var(--vz-muted-2)", fontSize: 11, marginLeft: 6 }}>shared</span>
                    )}
                  </span>
                </Checkbox>
              ))
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

function SecretSection() {
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

// ───────────────────────────────────────────────────────────────────
// Git providers
// ───────────────────────────────────────────────────────────────────

function GitSection() {
  const { data: providers, loading, refetch } = useApi<GitProviderInfo[]>(() => fetchUserGitProviders());
  const { data: oauthConfig } = useApi<GitOAuthConfig>(() => fetchGitOAuthConfig());
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"github" | "gitlab" | "bitbucket">("github");
  const [token, setToken] = useState("");
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [error, setError] = useState("");
  const [oauthStatus, setOauthStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (oauth === "success") {
      setOauthStatus({ type: "success", message: "Git provider connected" });
      refetch();
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } else if (oauth === "error") {
      setOauthStatus({ type: "error", message: params.get("message") ?? "OAuth connection failed" });
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, []);

  const handleOAuthConnect = async (provider: "github" | "gitlab" | "bitbucket") => {
    setConnecting(provider); setError("");
    try {
      const { url } = await getGitOAuthAuthorizeUrl(provider, "/settings");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start OAuth");
      setConnecting(null);
    }
  };

  const hasOAuth = oauthConfig && (oauthConfig.github || oauthConfig.gitlab || oauthConfig.bitbucket);

  const resetForm = () => {
    setName(""); setToken(""); setUserName(""); setUserEmail("");
    setType("github"); setEditingId(null); setShowForm(false); setError("");
  };
  const openEdit = (p: GitProviderInfo) => {
    setEditingId(p.id); setName(p.name); setType(p.type);
    setToken(p.token); setUserName(p.user_name ?? ""); setUserEmail(p.user_email ?? "");
    setShowForm(true);
  };

  const handleSave = async () => {
    setError("");
    try {
      if (editingId) {
        await updateUserGitProvider(editingId, { name, type, token, user_name: userName, user_email: userEmail });
      } else {
        if (!token || token === "••••••••") { setError("Token is required"); return; }
        await createUserGitProvider({ name, type, token, user_name: userName || undefined, user_email: userEmail || undefined });
      }
      resetForm(); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteUserGitProvider(id); setConfirmDeleteId(null); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
  };

  const cols: DataColumn<GitProviderInfo>[] = [
    { key: "name", label: "Name", render: (p) => <span style={{ fontWeight: 500, color: "var(--vz-ink)" }}>{p.name}</span> },
    { key: "type", label: "Type", render: (p) => <Badge>{p.type}</Badge> },
    {
      key: "committer",
      label: "Committer",
      render: (p) => p.user_name || p.user_email
        ? <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>{p.user_name}{p.user_email ? ` <${p.user_email}>` : ""}</span>
        : <span style={{ color: "var(--vz-muted-2)" }}>—</span>,
    },
    {
      key: "auth",
      label: "Auth",
      width: "90px",
      render: (p) => p.auth_method === "oauth" ? <Pill tone="ok">OAuth</Pill> : <Pill>PAT</Pill>,
    },
    {
      key: "_actions",
      label: "",
      width: "120px",
      align: "right",
      render: (p) => (
        <div style={{ display: "inline-flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          {p.auth_method !== "oauth" && (
            <button type="button" className="vz-action-btn" title="Edit" onClick={() => openEdit(p)}>
              <KeyRound size={13} />
            </button>
          )}
          <button type="button" className="vz-action-btn vz-action-btn--danger" title="Delete" onClick={() => setConfirmDeleteId(p.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      {oauthStatus && (
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            fontSize: 13, color: oauthStatus.type === "success" ? "var(--vz-ok)" : "var(--vz-fail)",
            background: oauthStatus.type === "success" ? "rgba(22, 163, 74, 0.08)" : "rgba(220, 38, 38, 0.08)",
            border: `1px solid ${oauthStatus.type === "success" ? "rgba(22, 163, 74, 0.25)" : "rgba(220, 38, 38, 0.25)"}`,
            padding: "10px 12px",
            borderRadius: "var(--vz-radius-md)",
            marginBottom: 16,
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          <span>{oauthStatus.message}</span>
          <button type="button" onClick={() => setOauthStatus(null)} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", fontSize: 12 }}>dismiss</button>
        </div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {hasOAuth && (
        <Card style={{ marginBottom: 16 }}>
          <SubLabel>Connect via OAuth (recommended)</SubLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {oauthConfig.github && (
              <Button variant="ghost" size="sm" icon={<GitBranch size={13} />} onClick={() => handleOAuthConnect("github")} disabled={connecting !== null}>
                {connecting === "github" ? "Connecting…" : "GitHub"}
              </Button>
            )}
            {oauthConfig.gitlab && (
              <Button variant="ghost" size="sm" icon={<GitBranch size={13} />} onClick={() => handleOAuthConnect("gitlab")} disabled={connecting !== null}>
                {connecting === "gitlab" ? "Connecting…" : "GitLab"}
              </Button>
            )}
            {oauthConfig.bitbucket && (
              <Button variant="ghost" size="sm" icon={<GitBranch size={13} />} onClick={() => handleOAuthConnect("bitbucket")} disabled={connecting !== null}>
                {connecting === "bitbucket" ? "Connecting…" : "Bitbucket"}
              </Button>
            )}
          </div>
        </Card>
      )}

      <DataTable
        title="Git providers"
        count={providers?.length}
        columns={cols}
        rows={providers ?? []}
        rowKey={(p) => p.id}
        loading={loading}
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add token</Button>}
        emptyState={
          <EmptyState
            icon={<GitBranch size={20} />}
            title="No git providers yet"
            description={hasOAuth ? "Connect via OAuth above, or add a personal access token." : "Add a personal access token to clone private repos."}
            action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Add token</Button>}
          />
        }
      />

      <Modal
        open={showForm}
        onClose={resetForm}
        size="md"
        dismissable={false}
        title={editingId ? `Edit · ${name}` : "Add git provider"}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={!name || (!editingId && (!token || token === "••••••••"))}>
              {editingId ? "Save" : "Add provider"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-github" />
            </Field>
            <Field label="Type">
              <Select
                options={[
                  { value: "github", label: "GitHub" },
                  { value: "gitlab", label: "GitLab" },
                  { value: "bitbucket", label: "Bitbucket" },
                ]}
                value={type}
                onChange={(v) => setType(v as typeof type)}
              />
            </Field>
          </div>
          <Field label={editingId ? "Token (leave blank to keep)" : "Personal access token"}>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={type === "github" ? "ghp_…" : type === "gitlab" ? "glpat-…" : "ATBB…"}
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Committer name">
              <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your Name" />
            </Field>
            <Field label="Committer email">
              <Input value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete git provider?"
        description="Profiles using this provider will lose write access on their next run."
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

// ───────────────────────────────────────────────────────────────────
// Integrations
// ───────────────────────────────────────────────────────────────────

function IntegrationSection() {
  const { data: integrations, loading, refetch } = useApi<Integration[]>(() => fetchIntegrations());
  const { data: slackConfig } = useApi<{ enabled: boolean }>(() => fetchSlackConfig());
  const { data: gmailConfig } = useApi<{ enabled: boolean }>(() => fetchGmailConfig());
  const { data: tellerConfig } = useApi<TellerConfigInfo>(() => fetchTellerConfig());
  const { data: telegramConfig } = useApi<TelegramConfigInfo>(() => fetchTelegramConfig());
  const { data: telegramBotsData, refetch: refetchTelegram } = useApi<{ bots: TelegramBot[] }>(() => fetchTelegramBots());
  const telegramBots = telegramBotsData?.bots ?? [];
  const { data: agentProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [oauthStatus, setOauthStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [connectingTeller, setConnectingTeller] = useState(false);
  // Scope editor: one modal serves every integration row (Bank, Gmail,
  // Slack, Telegram, Email, Webhook). Pre-populated when openScopeEditor
  // is called with the row.
  const [scopeEditOpen, setScopeEditOpen] = useState(false);
  const [scopeIntegration, setScopeIntegration] = useState<Integration | null>(null);
  const [scopeValue, setScopeValue] = useState<SecretScope>("all");
  const [scopeProfileIds, setScopeProfileIds] = useState<string[]>([]);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [error, setError] = useState("");

  // Email + webhook
  const [showEmail, setShowEmail] = useState(false);
  const [emailApiKey, setEmailApiKey] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [showWebhook, setShowWebhook] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);

  // Telegram
  const [showTelegram, setShowTelegram] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramBoundProfileId, setTelegramBoundProfileId] = useState<string>("");
  const [savingTelegram, setSavingTelegram] = useState(false);
  // Transient hint (keyed by bot id when scoped) shown after a fresh connect
  // to tell the user whether the t.me tab auto-opened or whether their popup
  // blocker swallowed it. The QR panel below the row is the persistent
  // fallback either way.
  const [telegramPopupHint, setTelegramPopupHint] = useState<{ botId: string; state: "opened" | "blocked" } | null>(null);

  const [testResult, setTestResult] = useState<{ id: string; status: "success" | "error"; message: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (oauth === "success") {
      const msg = params.get("message");
      const label = msg === "gmail_connected" ? "Gmail" : "Slack";
      setOauthStatus({ type: "success", message: `${label} connected` });
      refetch();
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } else if (oauth === "error") {
      setOauthStatus({ type: "error", message: params.get("message") ?? "Connection failed" });
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, []);

  const handleConnect = async () => {
    setConnecting(true); setError("");
    try { const { url } = await getSlackAuthorizeUrl("/settings"); window.location.href = url; }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to start OAuth"); setConnecting(false); }
  };
  const handleConnectGmail = async () => {
    setConnectingGmail(true); setError("");
    try { const { url } = await getGmailAuthorizeUrl("/settings"); window.location.href = url; }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to start Gmail OAuth"); setConnectingGmail(false); }
  };
  const handleConnectTeller = async () => {
    if (!tellerConfig?.enabled || !tellerConfig.application_id) {
      setError("Teller is not configured on this server.");
      return;
    }
    setConnectingTeller(true); setError("");
    try {
      await openTellerConnect({
        applicationId: tellerConfig.application_id,
        // Server-controlled. Default is "sandbox" (fake banks) so a fresh
        // deploy can't accidentally pull real data. Set TELLER_ENVIRONMENT
        // to "development" in the server env to link real personal banks
        // on Teller's free Developer tier.
        environment: tellerConfig.environment,
        selectAccount: "multiple",
        onSuccess: async (enrollment) => {
          try {
            await submitTellerEnrollment(enrollment);
            setOauthStatus({ type: "success", message: `${enrollment.enrollment.institution.name ?? "Bank"} connected` });
            refetch();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to save enrollment");
          } finally {
            setConnectingTeller(false);
          }
        },
        onExit: () => setConnectingTeller(false),
        onFailure: (f) => {
          setError(f.message ?? "Teller Connect failed");
          setConnectingTeller(false);
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open Teller Connect");
      setConnectingTeller(false);
    }
  };
  const handleDisconnect = async (id: string) => {
    try { await deleteIntegration(id); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed"); }
  };
  const handleTest = async (id: string) => {
    setTestingId(id); setTestResult(null);
    try { await testIntegration(id); setTestResult({ id, status: "success", message: "Test sent" }); }
    catch (e) { setTestResult({ id, status: "error", message: e instanceof Error ? e.message : "Test failed" }); }
    setTestingId(null);
  };
  const handleSetDefault = async (id: string) => {
    try { await updateIntegration(id, { is_default: true }); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to set default"); }
  };
  const handleSaveEmail = async () => {
    setSavingEmail(true);
    try {
      await createIntegration({ type: "email", config: { provider: "resend", api_key: emailApiKey, from_address: emailFrom } });
      setEmailApiKey(""); setEmailFrom(""); setShowEmail(false); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    setSavingEmail(false);
  };
  const handleSaveWebhook = async () => {
    setSavingWebhook(true);
    try {
      await createIntegration({ type: "webhook", config: { url: webhookUrl, secret: webhookSecret || undefined } });
      setWebhookUrl(""); setWebhookSecret(""); setShowWebhook(false); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    setSavingWebhook(false);
  };

  const handleSaveTelegram = async () => {
    setSavingTelegram(true);
    try {
      const result = await connectTelegram(telegramToken.trim(), {
        bound_profile_id: telegramBoundProfileId || null,
      });
      setTelegramToken(""); setTelegramBoundProfileId(""); setShowTelegram(false);
      refetch();
      refetchTelegram();
      // One-tap claim: open the t.me link in a new tab so Telegram (web or
      // desktop) can hand the user straight to the bot with /start <code>
      // already filled in. window.open() after an `await` may be popup-blocked
      // — the QR panel below the row is the persistent fallback either way.
      if (result.link_url) {
        let popup: Window | null = null;
        try { popup = window.open(result.link_url, "_blank", "noopener,noreferrer"); } catch { /* no-op */ }
        const blocked = !popup || popup.closed;
        setTelegramPopupHint({ botId: result.id, state: blocked ? "blocked" : "opened" });
        setTimeout(() => setTelegramPopupHint(null), 8000);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect"); }
    setSavingTelegram(false);
  };
  const handleConnectTelegramPlatform = async () => {
    setSavingTelegram(true);
    try {
      const result = await connectTelegramPlatform({
        bound_profile_id: telegramBoundProfileId || null,
      });
      setTelegramBoundProfileId("");
      refetch();
      refetchTelegram();
      // Same one-tap claim flow as the BYO-token path. Pop the t.me
      // link so the user lands in the platform bot's chat with the
      // pair code prefilled; if their browser blocks the popup, the
      // QR panel under the new row is the fallback.
      if (result.link_url) {
        let popup: Window | null = null;
        try { popup = window.open(result.link_url, "_blank", "noopener,noreferrer"); } catch { /* no-op */ }
        const blocked = !popup || popup.closed;
        setTelegramPopupHint({ botId: result.id, state: blocked ? "blocked" : "opened" });
        setTimeout(() => setTelegramPopupHint(null), 8000);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect platform bot"); }
    setSavingTelegram(false);
  };
  const handleDisconnectTelegram = async (botId: string) => {
    try {
      await disconnectTelegram(botId);
      refetch();
      refetchTelegram();
    } catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed"); }
  };
  const handleRegenerateLinkCode = async (botId: string) => {
    try {
      await regenerateTelegramLinkCode(botId);
      refetchTelegram();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to regenerate code"); }
  };
  const handleCopyLinkCode = async (code: string | null | undefined) => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch { /* clipboard may be unavailable */ }
  };
  const openScopeEditor = (integration: Integration) => {
    setScopeIntegration(integration);
    setScopeValue(integration.scope);
    setScopeProfileIds(integration.profile_ids ?? []);
    setScopeEditOpen(true);
  };
  const closeScopeEditor = () => {
    setScopeEditOpen(false);
    setScopeIntegration(null);
  };
  const handleScopeSave = async () => {
    if (!scopeIntegration) return;
    if (scopeValue === "agents" && scopeProfileIds.length === 0) {
      setError("Select at least one agent or switch to 'All agents'");
      return;
    }
    setScopeSaving(true);
    try {
      await updateIntegration(scopeIntegration.id, {
        scope: scopeValue,
        profile_ids: scopeValue === "agents" ? scopeProfileIds : undefined,
      });
      closeScopeEditor();
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update scope");
    } finally {
      setScopeSaving(false);
    }
  };

  const scopeSummary = (i?: { scope?: SecretScope; profile_ids?: string[] } | null): string => {
    if (!i || !i.scope || i.scope === "all") return "all agents";
    const names = (i.profile_ids ?? [])
      .map((pid) => agentProfiles?.find((p) => p.id === pid)?.name)
      .filter((n): n is string => !!n);
    if (names.length === 0) return "no agents";
    if (names.length === 1) return names[0];
    return `${names.length} agents`;
  };

  const handleUpdateTelegramBinding = async (botId: string, profileId: string | null) => {
    try {
      await updateTelegramBotBinding(botId, profileId);
      refetchTelegram();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to update agent binding"); }
  };

  const slack = integrations?.find((i) => i.type === "slack");
  const gmail = integrations?.find((i) => i.type === "gmail");
  const email = integrations?.find((i) => i.type === "email");
  const webhook = integrations?.find((i) => i.type === "webhook");
  const tellerEnrollments = integrations?.filter((i) => i.type === "teller") ?? [];

  return (
    <>
      {oauthStatus && (
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            fontSize: 13, color: oauthStatus.type === "success" ? "var(--vz-ok)" : "var(--vz-fail)",
            background: oauthStatus.type === "success" ? "rgba(22, 163, 74, 0.08)" : "rgba(220, 38, 38, 0.08)",
            border: `1px solid ${oauthStatus.type === "success" ? "rgba(22, 163, 74, 0.25)" : "rgba(220, 38, 38, 0.25)"}`,
            padding: "10px 12px",
            borderRadius: "var(--vz-radius-md)",
            marginBottom: 16,
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          <span>{oauthStatus.message}</span>
          <button type="button" onClick={() => setOauthStatus(null)} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", fontSize: 12 }}>dismiss</button>
        </div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {loading ? (
        <div style={{ padding: "32px 0", textAlign: "center", color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)", fontSize: 12 }}>
          loading…
        </div>
      ) : (
        <>
        <div
          style={{
            fontSize: 11,
            color: "var(--vz-muted-2)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            fontFamily: "var(--vz-font-mono)",
            margin: "0 0 8px",
          }}
        >
          Notifications &amp; chat
        </div>
        <Card style={{ padding: 0 }}>
          <IntegrationRow
            badgeBg="#4A154B" badgeChar="S" name="Slack"
            value={slack ? (slack.config.team_name as string) : "Not connected"}
            isDefault={slack?.is_default}
            connected={!!slack}
            available={!!slackConfig?.enabled}
            actions={
              slack ? (
                <>
                  {!slack.is_default && <Button variant="ghost" size="sm" onClick={() => handleSetDefault(slack.id)}>Set default</Button>}
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(slack)}>Scope: {scopeSummary(slack)}</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleTest(slack.id)} disabled={testingId === slack.id}>
                    {testingId === slack.id ? "Sending…" : "Test"}
                  </Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(slack.id)}>Disconnect</Button>
                </>
              ) : slackConfig?.enabled ? (
                <Button size="sm" onClick={handleConnect} disabled={connecting}>
                  {connecting ? "Connecting…" : "Connect Slack"}
                </Button>
              ) : null
            }
            testResult={testResult?.id === slack?.id ? testResult : undefined}
          />
          {/*
            Telegram supports multiple bots per user (Option A: one bot per
            agent flavor). Render each connected bot as its own row, then
            an "Add bot" row at the end. When there are zero connected
            bots, the "Add bot" row carries the full Connect CTA.
          */}
          {telegramBots.length === 0 ? (
            <IntegrationRow
              badgeBg="#229ED9" badgeChar="T" name="Telegram"
              value={telegramConfig?.platformBot
                ? `Not connected — one-tap pair with @${telegramConfig.platformBot.bot_username} or bring your own bot`
                : "Not connected"}
              connected={false}
              available
              actions={
                <>
                  {telegramConfig?.platformBot && (
                    <Button size="sm" onClick={handleConnectTelegramPlatform} disabled={savingTelegram || !telegramConfig.publicReachable}>
                      {savingTelegram ? "Pairing…" : `Connect with @${telegramConfig.platformBot.bot_username}`}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={telegramConfig?.platformBot ? "ghost" : "primary"}
                    onClick={() => setShowTelegram(true)}
                    disabled={!telegramConfig?.publicReachable}
                  >
                    {telegramConfig?.publicReachable
                      ? (telegramConfig.platformBot ? "Use your own bot" : "Connect Telegram bot")
                      : "Public URL required"}
                  </Button>
                </>
              }
            />
          ) : (
            <>
              {telegramBots.map((bot) => {
                const tgIntegration = integrations?.find((i) => i.id === bot.id);
                const isDefault = tgIntegration?.is_default;
                const platformTag = bot.is_platform_owned ? " · platform" : "";
                const valueText = bot.linked
                  ? `@${bot.bot_username}${bot.bound_profile_slug ? ` → @${bot.bound_profile_slug}` : " (any agent)"}${platformTag}`
                  : `@${bot.bot_username} — awaiting first message${platformTag}`;
                return (
                  <React.Fragment key={bot.id}>
                    <IntegrationRow
                      badgeBg="#229ED9" badgeChar="T" name="Telegram"
                      value={valueText}
                      isDefault={isDefault}
                      connected
                      available
                      actions={
                        <>
                          {!bot.linked && bot.link_url && (
                            <Button
                              size="sm"
                              onClick={() => { try { window.open(bot.link_url!, "_blank", "noopener,noreferrer"); } catch { /* no-op */ } }}
                            >
                              Open in Telegram
                            </Button>
                          )}
                          {!bot.linked && (
                            <Button variant="ghost" size="sm" onClick={() => handleCopyLinkCode(bot.link_code)}>
                              Copy code{bot.link_code ? ` (${bot.link_code})` : ""}
                            </Button>
                          )}
                          {!bot.linked && (
                            <Button variant="ghost" size="sm" onClick={() => handleRegenerateLinkCode(bot.id)}>New code</Button>
                          )}
                          {bot.linked && (
                            <>
                              <Select
                                value={bot.bound_profile_id ?? ""}
                                onChange={(v) => handleUpdateTelegramBinding(bot.id, v || null)}
                                options={[
                                  { value: "", label: "Any agent (default)" },
                                  ...(agentProfiles ?? []).map((p) => ({ value: p.id, label: `@${p.slug}` })),
                                ]}
                              />
                              {tgIntegration && !isDefault && (
                                <Button variant="ghost" size="sm" onClick={() => handleSetDefault(bot.id)}>Set default</Button>
                              )}
                              {tgIntegration && (
                                <Button variant="ghost" size="sm" onClick={() => openScopeEditor(tgIntegration)}>Scope: {scopeSummary(tgIntegration)}</Button>
                              )}
                              {tgIntegration && (
                                <Button variant="ghost" size="sm" onClick={() => handleTest(bot.id)} disabled={testingId === bot.id}>
                                  {testingId === bot.id ? "Sending…" : "Test"}
                                </Button>
                              )}
                            </>
                          )}
                          <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnectTelegram(bot.id)}>Disconnect</Button>
                        </>
                      }
                      testResult={testResult?.id === bot.id ? testResult : undefined}
                    />
                    {!bot.linked && bot.link_url && (
                      <div
                        style={{
                          display: "flex",
                          gap: 16,
                          alignItems: "center",
                          padding: "14px 18px",
                          background: "rgba(34, 158, 217, 0.06)",
                          borderTop: "1px solid var(--vz-border)",
                        }}
                      >
                        <div style={{ background: "#fff", padding: 6, borderRadius: 6, lineHeight: 0, flexShrink: 0 }}>
                          <QRCodeSVG value={bot.link_url} size={108} level="M" />
                        </div>
                        <div style={{ flex: 1, fontSize: 12.5, color: "var(--vz-muted)", lineHeight: 1.6 }}>
                          <div style={{ color: "var(--vz-text)", fontWeight: 500, marginBottom: 4 }}>
                            Finish linking on your phone
                          </div>
                          <div>
                            Scan with your camera, or tap <b>Open in Telegram</b> above. Then tap <b>Start</b> in the bot chat.
                          </div>
                          {telegramPopupHint?.botId === bot.id && telegramPopupHint.state === "blocked" && (
                            <div style={{ color: "var(--vz-warn, #c2410c)", marginTop: 6 }}>
                              Your browser blocked the auto-open. Use the QR or the button above.
                            </div>
                          )}
                          <div style={{ marginTop: 6, fontFamily: "var(--vz-font-mono)", fontSize: 11 }}>
                            Code: {bot.link_code}
                          </div>
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              <IntegrationRow
                badgeBg="#229ED9" badgeChar="+" name="Add Telegram bot"
                value="Connect another bot — bind it to a specific agent for direct access"
                connected={false}
                available
                actions={
                  <>
                    {/*
                      Only offer the platform bot here if the user doesn't
                      already have one paired — server enforces one-platform-
                      pairing-per-user. Keeps the row tidy.
                    */}
                    {telegramConfig?.platformBot && !telegramBots.some((b) => b.is_platform_owned) && (
                      <Button size="sm" onClick={handleConnectTelegramPlatform} disabled={savingTelegram || !telegramConfig.publicReachable}>
                        {savingTelegram ? "Pairing…" : `Pair @${telegramConfig.platformBot.bot_username}`}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setShowTelegram(true)} disabled={!telegramConfig?.publicReachable}>
                      {telegramConfig?.publicReachable ? "Add bot" : "Public URL required"}
                    </Button>
                  </>
                }
              />
            </>
          )}
          <IntegrationRow
            badgeBg="#2563EB" badgeChar="@" name="Email"
            value={email ? (email.config.from_address as string) : "Not configured"}
            isDefault={email?.is_default}
            connected={!!email}
            available
            actions={
              email ? (
                <>
                  {!email.is_default && <Button variant="ghost" size="sm" onClick={() => handleSetDefault(email.id)}>Set default</Button>}
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(email)}>Scope: {scopeSummary(email)}</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleTest(email.id)} disabled={testingId === email.id}>
                    {testingId === email.id ? "Sending…" : "Test"}
                  </Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(email.id)}>Disconnect</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setShowEmail(true)}>Configure</Button>
              )
            }
            testResult={testResult?.id === email?.id ? testResult : undefined}
          />
          <IntegrationRow
            badgeBg="#16A34A" badgeChar="W" name="Webhook"
            value={webhook ? (webhook.config.url as string) : "Not configured"}
            isDefault={webhook?.is_default}
            connected={!!webhook}
            available
            actions={
              webhook ? (
                <>
                  {!webhook.is_default && <Button variant="ghost" size="sm" onClick={() => handleSetDefault(webhook.id)}>Set default</Button>}
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(webhook)}>Scope: {scopeSummary(webhook)}</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleTest(webhook.id)} disabled={testingId === webhook.id}>
                    {testingId === webhook.id ? "Sending…" : "Test"}
                  </Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(webhook.id)}>Disconnect</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setShowWebhook(true)}>Configure</Button>
              )
            }
            testResult={testResult?.id === webhook?.id ? testResult : undefined}
            isLast
          />
        </Card>

        <div
          style={{
            fontSize: 11,
            color: "var(--vz-muted-2)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            fontFamily: "var(--vz-font-mono)",
            margin: "20px 0 8px",
          }}
        >
          Data sources
        </div>
        <Card style={{ padding: 0 }}>
          <IntegrationRow
            badgeBg="#DC2626" badgeChar="G" name="Gmail"
            value={gmail ? (gmail.config.email as string) : "Not connected"}
            connected={!!gmail}
            available={!!gmailConfig?.enabled}
            actions={
              gmail ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(gmail)}>Scope: {scopeSummary(gmail)}</Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(gmail.id)}>Disconnect</Button>
                </>
              ) : gmailConfig?.enabled ? (
                <Button size="sm" onClick={handleConnectGmail} disabled={connectingGmail}>
                  {connectingGmail ? "Connecting…" : "Connect Gmail"}
                </Button>
              ) : (
                <span style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>not configured by admin</span>
              )
            }
          />
          {tellerEnrollments.length === 0 ? (
            <IntegrationRow
              badgeBg="#10131B" badgeChar="$" name="Bank (Teller)"
              value={tellerConfig?.enabled ? "Not connected" : "Not configured by admin"}
              connected={false}
              available={!!tellerConfig?.enabled}
              actions={
                tellerConfig?.enabled ? (
                  <Button size="sm" onClick={handleConnectTeller} disabled={connectingTeller}>
                    {connectingTeller ? "Opening…" : "Connect bank"}
                  </Button>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>not configured by admin</span>
                )
              }
              isLast
            />
          ) : (
            <>
              {tellerEnrollments.map((row) => {
                const cfg = row.config as Record<string, unknown>;
                const institutionName = (cfg.institution_name as string | undefined) ?? "Bank";
                const enrolledAt = cfg.enrolled_at as string | undefined;
                const valueText = enrolledAt
                  ? `${institutionName} · linked ${formatDate(enrolledAt)}`
                  : institutionName;
                return (
                  <IntegrationRow
                    key={row.id}
                    badgeBg="#10131B" badgeChar="$" name="Bank (Teller)"
                    value={valueText}
                    connected
                    available
                    actions={
                      <>
                        <Button variant="ghost" size="sm" onClick={() => openScopeEditor(row)}>Scope: {scopeSummary(row)}</Button>
                        <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(row.id)}>
                          Disconnect
                        </Button>
                      </>
                    }
                  />
                );
              })}
              <IntegrationRow
                badgeBg="#10131B" badgeChar="+" name="Add bank"
                value="Link another institution via Teller Connect"
                connected={false}
                available
                actions={
                  <Button size="sm" variant="ghost" onClick={handleConnectTeller} disabled={connectingTeller}>
                    {connectingTeller ? "Opening…" : "Add bank"}
                  </Button>
                }
                isLast
              />
            </>
          )}
        </Card>
        </>
      )}

      <Modal
        open={scopeEditOpen && !!scopeIntegration}
        onClose={closeScopeEditor}
        size="md"
        dismissable={false}
        title={scopeIntegration ? `Scope · ${scopeIntegration.type}` : "Scope"}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeScopeEditor}>Cancel</Button>
            <Button size="sm" onClick={handleScopeSave} disabled={scopeSaving}>
              {scopeSaving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ScopePicker
            name="integrationScope"
            hint="All agents: every agent of yours can use this integration. Specific: only the selected agents."
            scope={scopeValue}
            setScope={setScopeValue}
            profileIds={scopeProfileIds}
            setProfileIds={setScopeProfileIds}
            agentProfiles={agentProfiles ?? []}
          />
        </div>
      </Modal>

      <Modal
        open={showEmail}
        onClose={() => setShowEmail(false)}
        size="md"
        dismissable={false}
        title="Configure email"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowEmail(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveEmail} disabled={savingEmail || !emailApiKey || !emailFrom}>
              {savingEmail ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Resend API key">
            <Input type="password" value={emailApiKey} onChange={(e) => setEmailApiKey(e.target.value)} placeholder="re_…" />
          </Field>
          <Field label="From address">
            <Input value={emailFrom} onChange={(e) => setEmailFrom(e.target.value)} placeholder="alerts@yourdomain.com" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={showTelegram}
        onClose={() => setShowTelegram(false)}
        size="md"
        dismissable={false}
        title="Connect Telegram bot"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowTelegram(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveTelegram} disabled={savingTelegram || !telegramToken.trim()}>
              {savingTelegram ? "Connecting…" : "Connect"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ol style={{ fontSize: 12.5, color: "var(--vz-muted)", paddingLeft: 18, lineHeight: 1.6, margin: 0 }}>
            <li>Open Telegram and message <b>@BotFather</b>.</li>
            <li>Send <code>/newbot</code> and follow the prompts to choose a name + username.</li>
            <li>BotFather replies with an HTTP API token — paste it below.</li>
            <li>After connecting, Telegram opens automatically — tap <b>Start</b> to link your account.</li>
          </ol>
          <Field label="Bot token" hint="Format: 123456789:ABC-DEF... — kept encrypted at rest.">
            <Input type="password" value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} placeholder="123456789:ABC..." />
          </Field>
          <Field
            label="Bind to agent (optional)"
            hint="When set, /new in this bot defaults to this agent — no @slug needed."
          >
            <Select
              value={telegramBoundProfileId}
              onChange={(v) => setTelegramBoundProfileId(v)}
              options={[
                { value: "", label: "Any agent (uses default)" },
                ...(agentProfiles ?? []).map((p) => ({ value: p.id, label: `@${p.slug} — ${p.name}` })),
              ]}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={showWebhook}
        onClose={() => setShowWebhook(false)}
        size="md"
        dismissable={false}
        title="Configure webhook"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowWebhook(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveWebhook} disabled={savingWebhook || !webhookUrl}>
              {savingWebhook ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Webhook URL">
            <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhook" />
          </Field>
          <Field label="HMAC secret" hint="Optional. Used to sign requests so you can verify their authenticity.">
            <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function IntegrationRow({
  badgeBg, badgeChar, name, value, isDefault, connected, available, actions, testResult, isLast,
}: {
  badgeBg: string;
  badgeChar: string;
  name: string;
  value: ReactNode;
  isDefault?: boolean;
  connected: boolean;
  available: boolean;
  actions: ReactNode;
  testResult?: { id: string; status: "success" | "error"; message: string } | null;
  isLast?: boolean;
}) {
  void connected; void available;
  return (
    <div style={{ padding: 16, borderBottom: isLast ? "0" : "1px solid var(--vz-border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 32, height: 32, borderRadius: "var(--vz-radius-md)",
              background: badgeBg, color: "#fff",
              display: "grid", placeItems: "center",
              fontWeight: 700, fontSize: 13, flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {badgeChar}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 500, color: "var(--vz-ink)", fontSize: 13.5 }}>{name}</span>
              {isDefault && <Pill tone="info">default</Pill>}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", marginTop: 2 }}>
              {value}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {actions}
        </div>
      </div>
      {testResult && (
        <div style={{ marginTop: 8, fontSize: 11.5, fontFamily: "var(--vz-font-mono)", color: testResult.status === "success" ? "var(--vz-ok)" : "var(--vz-fail)" }}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// API tokens
// ───────────────────────────────────────────────────────────────────

function ApiTokenSection() {
  const { data: keys, loading, refetch } = useApi<ApiTokenInfo[]>(() => fetchApiTokens());
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [rpm, setRpm] = useState("60");
  const [newKeyResult, setNewKeyResult] = useState<{ name: string; token: string } | null>(null);
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
        <Card style={{ marginBottom: 16, borderLeft: "3px solid var(--vz-ok)" }}>
          <SubLabel>New token</SubLabel>
          <p style={{ fontSize: 13.5, color: "var(--vz-ink)", margin: 0 }}>
            <strong>{newKeyResult.name}</strong>:{" "}
            <code style={{ fontFamily: "var(--vz-font-mono)", fontSize: 12.5, background: "var(--vz-mute)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--vz-border)" }}>
              {newKeyResult.token}
            </code>
          </p>
          <p style={{ fontSize: 11.5, color: "var(--vz-warn)", margin: "8px 0 0", fontFamily: "var(--vz-font-mono)" }}>
            save this — it won't be shown again
          </p>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--vz-border)" }}>
            <SubLabel>Quick start</SubLabel>
            <CodeRow
              label="chat page"
              value={`${window.location.origin}/chat?key=${newKeyResult.token}`}
            />
            <CodeRow
              label="embed widget"
              value={`<script src="${window.location.origin}/widget/vonzio.js" data-key="${newKeyResult.token}"></script>`}
            />
          </div>
          <div style={{ marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setNewKeyResult(null)}>Dismiss</Button>
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
        actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Create token</Button>}
        emptyState={
          <EmptyState
            icon={<Shield size={20} />}
            title="No API tokens yet"
            description="Create a token for embed widgets, the CLI, or programmatic access."
            action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setShowForm(true)}>Create token</Button>}
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
        description="Any client (widget, CLI, integration) using this token will stop working."
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

function CodeRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
      <span style={{
        fontFamily: "var(--vz-font-mono)", fontSize: 10.5,
        letterSpacing: "0.04em", color: "var(--vz-muted-2)",
        width: 90, flexShrink: 0,
      }}>
        {label}
      </span>
      <code
        style={{
          flex: 1,
          fontFamily: "var(--vz-font-mono)", fontSize: 11,
          background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
          borderRadius: "var(--vz-radius-sm)",
          padding: "4px 8px",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: "var(--vz-ink-3)",
        }}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        className="vz-action-btn"
        title="Copy"
        onClick={() => navigator.clipboard.writeText(value)}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
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
      <button type="button" onClick={onDismiss} style={{ background: "none", border: 0, cursor: "pointer", color: "var(--vz-fail)", fontSize: 12 }}>
        ×
      </button>
    </div>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--vz-font-mono)",
      fontSize: 11,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "var(--vz-muted-2)",
      marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

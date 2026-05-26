import { useState, useEffect } from "react";
import { GitBranch, Trash2, KeyRound, Plus } from "lucide-react";
import { useApi } from "../../../hooks/useApi.js";
import {
  fetchGitOAuthConfig, getGitOAuthAuthorizeUrl,
  fetchUserGitProviders, createUserGitProvider, updateUserGitProvider, deleteUserGitProvider,
  type GitProviderInfo,
  type GitOAuthConfig,
} from "../../../api/client.js";
import {
  Card, Button, Field, Input, Select,
  Pill, Badge, Modal, EmptyState, DataTable,
  type DataColumn,
} from "../../../brand/components.js";
import { ErrorBanner, SubLabel } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// Git providers
// ───────────────────────────────────────────────────────────────────

export function GitSection() {
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
        // openEdit pre-fills `token` with the masked placeholder the server
        // returned. Sending that back as-is would store "••••••••" as the
        // real token and break the next git operation. Only include the
        // field when the user actually typed something new.
        const payload: Record<string, unknown> = { name, type, user_name: userName, user_email: userEmail };
        if (token && token !== "••••••••") payload.token = token;
        await updateUserGitProvider(editingId, payload);
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

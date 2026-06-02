import { useState, useEffect, type ReactNode } from "react";
import { useApi } from "../../../hooks/useApi.js";
import {
  fetchGmailConfig, getGmailAuthorizeUrl,
  fetchTellerConfig, submitTellerEnrollment, type TellerConfigInfo,
  fetchIntegrations, deleteIntegration, createIntegration, updateIntegration, testIntegration,
  type Integration,
  type SecretScope,
  fetchProfiles, type ProfileSummary,
} from "../../../api/client.js";
// Slack API moved into the plugin in Phase 3E.2. Slack's dashboard
// surface is one row (Connect/Disconnect button), too small to
// warrant moving the JSX too -- left here, importing from the
// plugin's API client. Mirrors how Telegram bot list import in
// Playbooks.tsx works post-3D.1e.
import { fetchSlackConfig, getSlackAuthorizeUrl } from "@vonzio/plugin-slack/dashboard/api";
import {
  Card, Button, Field, Input, Select,
  Pill, Modal,
} from "../../../brand/components.js";
import { formatDate } from "../../../lib/utils.js";
import { openTellerConnect } from "../../../lib/teller-connect.js";
import { ErrorBanner, ScopePicker } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// Integrations
// ───────────────────────────────────────────────────────────────────

export function IntegrationSection() {
  const { data: integrations, loading, refetch } = useApi<Integration[]>(() => fetchIntegrations());
  const { data: slackConfig } = useApi<{ enabled: boolean }>(() => fetchSlackConfig());
  const { data: gmailConfig } = useApi<{ enabled: boolean }>(() => fetchGmailConfig());
  const { data: tellerConfig } = useApi<TellerConfigInfo>(() => fetchTellerConfig());
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
            Telegram bot list + connect flow moved to
            @vonzio/plugin-telegram/dashboard/TelegramSettings.tsx
            (Phase 3D.1e). Surfaced at /settings#telegram via the
            plugin's registerSettingsSection contribution.
          */}
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

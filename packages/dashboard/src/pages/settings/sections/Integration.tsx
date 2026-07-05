import { useState, useEffect, type ReactNode } from "react";
import { useApi } from "../../../hooks/useApi.js";
import {
  fetchIntegrations, deleteIntegration, createIntegration, updateIntegration, testIntegration,
  type Integration,
  type SecretScope,
  fetchProfiles, type ProfileSummary,
} from "../../../api/client.js";
// Slack contributes its row via registerIntegrationRow (Phase 3F.1)
// -- no slack-specific imports needed here anymore.
import {
  Card, Button, Field, Input, Select,
  Pill, Modal,
} from "../../../brand/components.js";
import { ErrorBanner, ScopePicker } from "./_shared.js";
import { getIntegrationRows, useEntitlements } from "../../../registry/index.js";

// ───────────────────────────────────────────────────────────────────
// Integrations
// ───────────────────────────────────────────────────────────────────

export function IntegrationSection() {
  const { data: integrations, loading, refetch } = useApi<Integration[]>(() => fetchIntegrations());
  const { data: agentProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [oauthStatus, setOauthStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  // Scope editor: one modal serves every integration row (Bank,
  // Slack, Telegram, Email, Webhook). Pre-populated when openScopeEditor
  // is called with the row.
  const [scopeEditOpen, setScopeEditOpen] = useState(false);
  const [scopeIntegration, setScopeIntegration] = useState<Integration | null>(null);
  const [scopeValue, setScopeValue] = useState<SecretScope>("all");
  const [scopeProfileIds, setScopeProfileIds] = useState<string[]>([]);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [error, setError] = useState("");

  // Email + webhook
  const [showMail, setShowMail] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const [calPreset, setCalPreset] = useState("google");
  const [calForm, setCalForm] = useState({ caldav_url: "https://apidata.googleusercontent.com/caldav/v2/", username: "", password: "" });
  const [savingCal, setSavingCal] = useState(false);
  const [mailPreset, setMailPreset] = useState("gmail");
  const [mailForm, setMailForm] = useState({ imap_host: "imap.gmail.com", imap_port: "993", smtp_host: "smtp.gmail.com", smtp_port: "465", username: "", password: "", from_name: "" });
  const [savingMail, setSavingMail] = useState(false);
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
    // Git providers share the Integrations tab but own their own callback
    // (?source=git, handled in Git.tsx). Without this guard the git callback's
    // ?oauth=success falls through to the slack inference below and shows
    // a bogus "Slack connected" banner.
    if (params.get("source") === "git") return;
    if (oauth === "success") {
      const msg = params.get("message");
      setOauthStatus({ type: "success", message: "Slack connected" });
      refetch();
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    } else if (oauth === "error") {
      setOauthStatus({ type: "error", message: params.get("message") ?? "Connection failed" });
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, []);

  const mail = integrations?.find((i) => i.type === "mail");
  const cal = integrations?.find((i) => i.type === "calendar");
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
  const MAIL_PRESETS: Record<string, { imap_host: string; imap_port: string; smtp_host: string; smtp_port: string }> = {
    gmail: { imap_host: "imap.gmail.com", imap_port: "993", smtp_host: "smtp.gmail.com", smtp_port: "465" },
    outlook: { imap_host: "outlook.office365.com", imap_port: "993", smtp_host: "smtp.office365.com", smtp_port: "587" },
    fastmail: { imap_host: "imap.fastmail.com", imap_port: "993", smtp_host: "smtp.fastmail.com", smtp_port: "465" },
    icloud: { imap_host: "imap.mail.me.com", imap_port: "993", smtp_host: "smtp.mail.me.com", smtp_port: "587" },
    custom: { imap_host: "", imap_port: "993", smtp_host: "", smtp_port: "465" },
  };
  const applyMailPreset = (preset: string) => {
    setMailPreset(preset);
    const p = MAIL_PRESETS[preset];
    if (p && preset !== "custom") setMailForm((f) => ({ ...f, ...p }));
  };
  const CAL_PRESETS: Record<string, string> = {
    google: "https://apidata.googleusercontent.com/caldav/v2/",
    icloud: "https://caldav.icloud.com/",
    fastmail: "https://caldav.fastmail.com/dav/",
    nextcloud: "",
    custom: "",
  };
  const applyCalPreset = (preset: string) => {
    setCalPreset(preset);
    if (CAL_PRESETS[preset]) setCalForm((f) => ({ ...f, caldav_url: CAL_PRESETS[preset] }));
  };
  const handleSaveCal = async () => {
    setSavingCal(true); setError("");
    try {
      await createIntegration({ type: "calendar", config: { caldav_url: calForm.caldav_url, username: calForm.username, password: calForm.password } });
      setCalForm({ caldav_url: "https://apidata.googleusercontent.com/caldav/v2/", username: "", password: "" });
      setShowCal(false); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect calendar"); }
    setSavingCal(false);
  };
  const handleSaveMail = async () => {
    setSavingMail(true); setError("");
    try {
      await createIntegration({ type: "mail", config: {
        imap_host: mailForm.imap_host, imap_port: Number(mailForm.imap_port) || 993,
        smtp_host: mailForm.smtp_host, smtp_port: Number(mailForm.smtp_port) || 465,
        username: mailForm.username, password: mailForm.password,
        security: Number(mailForm.smtp_port) === 587 ? "starttls" : "tls",
        from_name: mailForm.from_name || undefined,
      } });
      setMailForm({ imap_host: "imap.gmail.com", imap_port: "993", smtp_host: "smtp.gmail.com", smtp_port: "465", username: "", password: "", from_name: "" });
      setShowMail(false); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect mailbox"); }
    setSavingMail(false);
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

  const email = integrations?.find((i) => i.type === "email");
  const webhook = integrations?.find((i) => i.type === "webhook");

  // Plugin-contributed integration rows. Each plugin's frontend.tsx
  // calls registerIntegrationRow with a section ("notifications" |
  // "data-sources" | "other"); we render them at the bottom of each
  // section's Card after the hardcoded rows.
  const entitlements = useEntitlements();
  const slotProps = {
    integrations: integrations ?? [],
    agentProfiles: (agentProfiles ?? []).map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
    })),
    refetch,
    // Wrap to take an id so the slot prop signature stays narrow
    // (Integration.openScopeEditor takes the wider Integration row).
    openScopeEditor: (integrationId: string) => {
      const row = integrations?.find((i) => i.id === integrationId);
      if (row) openScopeEditor(row);
    },
    handleSetDefault,
    handleTest,
    testResult,
    testingId,
    scopeSummary,
  };
  function renderRows(section: "notifications" | "data-sources" | "other") {
    return getIntegrationRows(section)
      .filter((r) => !r.entitlement || entitlements.includes(r.entitlement))
      .map((reg) => {
        const Comp = reg.component;
        return <Comp key={reg.id} {...slotProps} />;
      });
  }

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
          {/*
            Slack row moved to @vonzio/plugin-slack and contributes
            via registerIntegrationRow (Phase 3F.1).
            Telegram has its own /settings#telegram tab via
            registerSettingsSection (Phase 3D.1e).
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
            // Stay non-last so the bottom seam survives when a plugin
            // adds a notifications row below; if no plugins register,
            // the row's bottom border is hidden by Card's own border.
            isLast={getIntegrationRows("notifications").length === 0}
          />
          {renderRows("notifications")}
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
            badgeBg="#7C3AED" badgeChar="C" name="Calendar"
            value={cal ? (cal.config.username as string) : "Not connected"}
            connected={!!cal}
            available
            actions={
              cal ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(cal)}>Scope: {scopeSummary(cal)}</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleTest(cal.id)}>Test</Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(cal.id)}>Disconnect</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => { setError(""); setShowCal(true); }}>Connect calendar</Button>
              )
            }
          />
          <IntegrationRow
            badgeBg="#0EA5E9" badgeChar="M" name="Mail"
            value={mail ? (mail.config.username as string) : "Not connected"}
            connected={!!mail}
            available
            actions={
              mail ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openScopeEditor(mail)}>Scope: {scopeSummary(mail)}</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleTest(mail.id)}>Test</Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(mail.id)}>Disconnect</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => { setError(""); setShowMail(true); }}>Connect mailbox</Button>
              )
            }
          />
          {/* All data-source rows are plugin-contributed via
              registerIntegrationRow(section: "data-sources") — e.g. Bank
              (@vonzio/plugin-teller). Gmail v1 was removed (feature 0034:
              CASA-locked, replaced by the BYO-client design). */}
          {renderRows("data-sources")}
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
        open={showCal}
        onClose={() => setShowCal(false)}
        size="md"
        dismissable={false}
        title="Connect a calendar"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowCal(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveCal} disabled={savingCal || !calForm.username || !calForm.password || !calForm.caldav_url}>
              {savingCal ? "Verifying…" : "Connect"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Provider">
            <Select
              value={calPreset}
              onChange={applyCalPreset}
              options={[
                { value: "google", label: "Google Calendar" },
                { value: "icloud", label: "iCloud" },
                { value: "fastmail", label: "Fastmail" },
                { value: "nextcloud", label: "Nextcloud" },
                { value: "custom", label: "Custom (CalDAV)" },
              ]}
            />
          </Field>
          {(calPreset === "google" || calPreset === "icloud") && (
            <div style={{ fontSize: 12, color: "var(--vz-muted)" }}>
              {calPreset === "google" ? "Google" : "iCloud"} needs an <strong>app password</strong> (2-Step Verification → App passwords), not your normal password.
            </div>
          )}
          <Field label="CalDAV URL">
            <Input value={calForm.caldav_url} onChange={(e) => setCalForm((f) => ({ ...f, caldav_url: e.target.value }))} placeholder="https://caldav.example.com/" />
          </Field>
          <Field label="Username (email)">
            <Input value={calForm.username} onChange={(e) => setCalForm((f) => ({ ...f, username: e.target.value }))} placeholder="you@example.com" />
          </Field>
          <Field label="App password">
            <Input type="password" value={calForm.password} onChange={(e) => setCalForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••••••" />
          </Field>
          <div style={{ fontSize: 11, color: "var(--vz-muted-2)" }}>
            Credentials are encrypted at rest. Your agents connect through the server — they never see the password.
          </div>
        </div>
      </Modal>

      <Modal
        open={showMail}
        onClose={() => setShowMail(false)}
        size="md"
        dismissable={false}
        title="Connect a mailbox"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowMail(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveMail} disabled={savingMail || !mailForm.username || !mailForm.password || !mailForm.imap_host || !mailForm.smtp_host}>
              {savingMail ? "Verifying…" : "Connect"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Provider">
            <Select
              value={mailPreset}
              onChange={applyMailPreset}
              options={[
                { value: "gmail", label: "Gmail" },
                { value: "outlook", label: "Outlook / Office 365" },
                { value: "fastmail", label: "Fastmail" },
                { value: "icloud", label: "iCloud" },
                { value: "custom", label: "Custom (IMAP/SMTP)" },
              ]}
            />
          </Field>
          {mailPreset === "gmail" && (
            <div style={{ fontSize: 12, color: "var(--vz-muted)" }}>
              Gmail needs an <strong>app password</strong> (Google account → 2-Step Verification → App passwords), not your normal password. Gmail-native OAuth is coming.
            </div>
          )}
          <Field label="Email address (username)">
            <Input value={mailForm.username} onChange={(e) => setMailForm((f) => ({ ...f, username: e.target.value }))} placeholder="you@example.com" />
          </Field>
          <Field label="App password">
            <Input type="password" value={mailForm.password} onChange={(e) => setMailForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••••••" />
          </Field>
          <Field label="Display name (optional)">
            <Input value={mailForm.from_name} onChange={(e) => setMailForm((f) => ({ ...f, from_name: e.target.value }))} placeholder="Your Name" />
          </Field>
          {mailPreset === "custom" && (
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
              <Field label="IMAP host"><Input value={mailForm.imap_host} onChange={(e) => setMailForm((f) => ({ ...f, imap_host: e.target.value }))} placeholder="imap.example.com" /></Field>
              <Field label="IMAP port"><Input value={mailForm.imap_port} onChange={(e) => setMailForm((f) => ({ ...f, imap_port: e.target.value }))} /></Field>
              <Field label="SMTP host"><Input value={mailForm.smtp_host} onChange={(e) => setMailForm((f) => ({ ...f, smtp_host: e.target.value }))} placeholder="smtp.example.com" /></Field>
              <Field label="SMTP port"><Input value={mailForm.smtp_port} onChange={(e) => setMailForm((f) => ({ ...f, smtp_port: e.target.value }))} /></Field>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--vz-muted-2)" }}>
            Credentials are encrypted at rest. Your agents connect through the server — they never see the password.
          </div>
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

export function IntegrationRow({
  badgeBg, badgeChar, name, value, isDefault, connected, available, actions, testResult, isLast,
}: {
  badgeBg: string;
  badgeChar: ReactNode;
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

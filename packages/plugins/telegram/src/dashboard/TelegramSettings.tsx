// Real Telegram settings card -- replaces the placeholder scaffold from #72.
//
// Lives in `/settings#telegram` (the tab the plugin contributes via
// `registerSettingsSection`). Renders:
//   - One row per linked bot (with bound-agent picker + scope/default/test
//     actions + disconnect)
//   - One "Add bot" row at the end (with platform-bot one-tap + BYO-token)
//   - QR-code panel inline under each not-yet-linked bot row
//   - Modal for the BYO-bot connect flow
//
// All telegram-specific API calls live in ./api.ts (plugin-owned).
// Generic Integration endpoints (scope edit, test, set-default) also
// live there because the plugin handles a self-contained slice of the
// integrations system.

import React, { useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useApi } from "@vonzio/dashboard/hooks/useApi";
import { Card, Button, Field, Input, Select, Pill, Modal, Radio, Checkbox } from "@vonzio/dashboard/brand/components";
import {
  fetchTelegramConfig, fetchTelegramBots,
  connectTelegram, connectTelegramPlatform,
  disconnectTelegram, regenerateTelegramLinkCode,
  updateTelegramBotBinding,
  fetchIntegrations, updateIntegration, testIntegration,
  fetchProfiles,
  type TelegramBot, type TelegramConfigInfo,
  type Integration, type SecretScope, type ProfileSummary,
} from "./api.js";

// ───────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────

export function TelegramSettings() {
  const { data: telegramConfig } = useApi<TelegramConfigInfo>(() => fetchTelegramConfig());
  const { data: telegramBotsData, refetch: refetchTelegram } = useApi<{ bots: TelegramBot[] }>(() => fetchTelegramBots());
  const { data: integrations, refetch: refetchIntegrations } = useApi<Integration[]>(() => fetchIntegrations());
  const { data: agentProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());

  const telegramBots = telegramBotsData?.bots ?? [];

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [token, setToken] = useState("");
  const [boundProfileId, setBoundProfileId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // Transient hint (keyed by bot id) shown after a fresh connect to tell the
  // user whether the t.me tab auto-opened or whether their popup blocker
  // swallowed it. QR panel below the row is the persistent fallback.
  const [popupHint, setPopupHint] = useState<{ botId: string; state: "opened" | "blocked" } | null>(null);

  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<{ id: string; status: "success" | "error"; message: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Scope editor (one modal, opens with the active integration row).
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeIntegration, setScopeIntegration] = useState<Integration | null>(null);
  const [scopeValue, setScopeValue] = useState<SecretScope>("all");
  const [scopeProfileIds, setScopeProfileIds] = useState<string[]>([]);
  const [scopeSaving, setScopeSaving] = useState(false);

  async function attemptPopup(botId: string, linkUrl: string | null | undefined): Promise<void> {
    if (!linkUrl) return;
    let popup: Window | null = null;
    try { popup = window.open(linkUrl, "_blank", "noopener,noreferrer"); } catch { /* no-op */ }
    const blocked = !popup || popup.closed;
    setPopupHint({ botId, state: blocked ? "blocked" : "opened" });
    setTimeout(() => setPopupHint(null), 8000);
  }

  async function handleConnectBYO() {
    setSaving(true);
    try {
      const result = await connectTelegram(token.trim(), {
        bound_profile_id: boundProfileId || null,
      });
      setToken(""); setBoundProfileId(""); setShowConnectModal(false);
      refetchTelegram(); refetchIntegrations();
      await attemptPopup(result.id, result.link_url);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect"); }
    setSaving(false);
  }

  async function handleConnectPlatform() {
    setSaving(true);
    try {
      const result = await connectTelegramPlatform({
        bound_profile_id: boundProfileId || null,
      });
      setBoundProfileId("");
      refetchTelegram(); refetchIntegrations();
      await attemptPopup(result.id, result.link_url);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to connect platform bot"); }
    setSaving(false);
  }

  async function handleDisconnect(botId: string) {
    try {
      await disconnectTelegram(botId);
      refetchTelegram(); refetchIntegrations();
    } catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed"); }
  }

  async function handleRegenerate(botId: string) {
    try {
      await regenerateTelegramLinkCode(botId);
      refetchTelegram();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to regenerate code"); }
  }

  async function handleCopyCode(code: string | null | undefined) {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch { /* clipboard may be unavailable */ }
  }

  async function handleUpdateBinding(botId: string, profileId: string | null) {
    try {
      await updateTelegramBotBinding(botId, profileId);
      refetchTelegram();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to update agent binding"); }
  }

  async function handleSetDefault(id: string) {
    try {
      await updateIntegration(id, { is_default: true });
      refetchIntegrations();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to set default"); }
  }

  async function handleTest(id: string) {
    setTestingId(id); setTestResult(null);
    try { await testIntegration(id); setTestResult({ id, status: "success", message: "Test sent" }); }
    catch (e) { setTestResult({ id, status: "error", message: e instanceof Error ? e.message : "Test failed" }); }
    setTestingId(null);
  }

  function openScopeEditor(integration: Integration) {
    setScopeIntegration(integration);
    setScopeValue(integration.scope);
    setScopeProfileIds(integration.profile_ids ?? []);
    setScopeOpen(true);
  }

  async function handleScopeSave() {
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
      setScopeOpen(false);
      setScopeIntegration(null);
      refetchIntegrations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update scope");
    } finally {
      setScopeSaving(false);
    }
  }

  function scopeSummary(i?: { scope?: SecretScope; profile_ids?: string[] } | null): string {
    if (!i || !i.scope || i.scope === "all") return "all agents";
    const names = (i.profile_ids ?? [])
      .map((pid) => agentProfiles?.find((p) => p.id === pid)?.name)
      .filter((n): n is string => !!n);
    if (names.length === 0) return "no agents";
    if (names.length === 1) return names[0];
    return `${names.length} agents`;
  }

  return (
    <>
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError("")} />
      )}

      <Card>
        {telegramBots.length === 0 ? (
          <Row
            badgeBg="#229ED9" badgeChar="T" name="Telegram"
            value={telegramConfig?.platformBot
              ? `Not connected — one-tap pair with @${telegramConfig.platformBot.bot_username} or bring your own bot`
              : "Not connected"}
            actions={
              <>
                {telegramConfig?.platformBot && (
                  <Button size="sm" onClick={handleConnectPlatform} disabled={saving || !telegramConfig.publicReachable}>
                    {saving ? "Pairing…" : `Connect with @${telegramConfig.platformBot.bot_username}`}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={telegramConfig?.platformBot ? "ghost" : "primary"}
                  onClick={() => setShowConnectModal(true)}
                  disabled={!telegramConfig?.publicReachable}
                >
                  {telegramConfig?.publicReachable
                    ? (telegramConfig.platformBot ? "Use your own bot" : "Connect Telegram bot")
                    : "Public URL required"}
                </Button>
              </>
            }
            isLast
          />
        ) : (
          <>
            {telegramBots.map((bot, idx) => {
              const tgIntegration = integrations?.find((i) => i.id === bot.id);
              const isDefault = tgIntegration?.is_default;
              const platformTag = bot.is_platform_owned ? " · platform" : "";
              const valueText = bot.linked
                ? `@${bot.bot_username}${bot.bound_profile_slug ? ` → @${bot.bound_profile_slug}` : " (any agent)"}${platformTag}`
                : `@${bot.bot_username} — awaiting first message${platformTag}`;
              const isFinalBot = idx === telegramBots.length - 1 && bot.linked;
              return (
                <React.Fragment key={bot.id}>
                  <Row
                    badgeBg="#229ED9" badgeChar="T" name="Telegram"
                    value={valueText}
                    isDefault={isDefault}
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
                          <Button variant="ghost" size="sm" onClick={() => handleCopyCode(bot.link_code)}>
                            Copy code{bot.link_code ? ` (${bot.link_code})` : ""}
                          </Button>
                        )}
                        {!bot.linked && (
                          <Button variant="ghost" size="sm" onClick={() => handleRegenerate(bot.id)}>New code</Button>
                        )}
                        {bot.linked && (
                          <>
                            <Select
                              value={bot.bound_profile_id ?? ""}
                              onChange={(v) => handleUpdateBinding(bot.id, v || null)}
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
                        <Button variant="danger-ghost" size="sm" onClick={() => handleDisconnect(bot.id)}>Disconnect</Button>
                      </>
                    }
                    testResult={testResult?.id === bot.id ? testResult : undefined}
                    isLast={isFinalBot ? false : false}
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
                        {popupHint?.botId === bot.id && popupHint.state === "blocked" && (
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
            <Row
              badgeBg="#229ED9" badgeChar="+" name="Add Telegram bot"
              value="Connect another bot — bind it to a specific agent for direct access"
              actions={
                <>
                  {/* Server enforces one-platform-pairing-per-user; only offer
                     the platform bot here when the user doesn't already have one. */}
                  {telegramConfig?.platformBot && !telegramBots.some((b) => b.is_platform_owned) && (
                    <Button size="sm" onClick={handleConnectPlatform} disabled={saving || !telegramConfig.publicReachable}>
                      {saving ? "Pairing…" : `Pair @${telegramConfig.platformBot.bot_username}`}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setShowConnectModal(true)} disabled={!telegramConfig?.publicReachable}>
                    {telegramConfig?.publicReachable ? "Add bot" : "Public URL required"}
                  </Button>
                </>
              }
              isLast
            />
          </>
        )}
      </Card>

      {/* BYO-token connect modal */}
      <Modal
        open={showConnectModal}
        onClose={() => setShowConnectModal(false)}
        size="md"
        dismissable={false}
        title="Connect Telegram bot"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowConnectModal(false)}>Cancel</Button>
            <Button size="sm" onClick={handleConnectBYO} disabled={saving || !token.trim()}>
              {saving ? "Connecting…" : "Connect"}
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
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:ABC..." />
          </Field>
          <Field
            label="Bind to agent (optional)"
            hint="When set, /new in this bot defaults to this agent — no @slug needed."
          >
            <Select
              value={boundProfileId}
              onChange={(v) => setBoundProfileId(v)}
              options={[
                { value: "", label: "Any agent (uses default)" },
                ...(agentProfiles ?? []).map((p) => ({ value: p.id, label: `@${p.slug} — ${p.name}` })),
              ]}
            />
          </Field>
        </div>
      </Modal>

      {/* Scope edit modal */}
      <Modal
        open={scopeOpen}
        onClose={() => { setScopeOpen(false); setScopeIntegration(null); }}
        size="md"
        dismissable={!scopeSaving}
        title="Scope this integration"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => { setScopeOpen(false); setScopeIntegration(null); }} disabled={scopeSaving}>Cancel</Button>
            <Button size="sm" onClick={handleScopeSave} disabled={scopeSaving}>
              {scopeSaving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Scope" hint="All agents: every agent can use this integration. Specific: only the selected agents.">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Radio
                name="telegram-scope"
                checked={scopeValue === "all"}
                onChange={(c) => { if (c) setScopeValue("all"); }}
              >
                All agents
              </Radio>
              <Radio
                name="telegram-scope"
                checked={scopeValue === "agents"}
                onChange={(c) => { if (c) setScopeValue("agents"); }}
              >
                Specific agents
              </Radio>
              {scopeValue === "agents" && (
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
                  {(agentProfiles ?? []).length === 0 ? (
                    <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>No agents available.</span>
                  ) : (
                    (agentProfiles ?? []).map((p) => (
                      <Checkbox
                        key={p.id}
                        checked={scopeProfileIds.includes(p.id)}
                        onChange={(checked) => {
                          if (checked) setScopeProfileIds([...scopeProfileIds, p.id]);
                          else setScopeProfileIds(scopeProfileIds.filter((id) => id !== p.id));
                        }}
                      >
                        <span style={{ fontSize: 13 }}>{p.name}</span>
                      </Checkbox>
                    ))
                  )}
                </div>
              )}
            </div>
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Helpers (inlined from dashboard internals -- ScopePicker fully
// inlined above; this is a compact row component matching the visual
// style of dashboard's IntegrationRow).
// ───────────────────────────────────────────────────────────────────

function Row({
  badgeBg, badgeChar, name, value, isDefault, actions, testResult, isLast,
}: {
  badgeBg: string;
  badgeChar: string;
  name: string;
  value: ReactNode;
  isDefault?: boolean;
  actions: ReactNode;
  testResult?: { id: string; status: "success" | "error"; message: string } | null;
  isLast?: boolean;
}) {
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

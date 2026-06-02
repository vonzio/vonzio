// Slack's contribution to the dashboard's IntegrationRow slot.
// Renders the single "Connect Slack" / "Connected to <team_name>" row
// inside Settings > Integrations > Notifications & chat.
//
// Moved here from packages/dashboard/src/pages/settings/sections/Integration.tsx
// in Phase 3F.1. The plugin owns its UI placement now -- before this,
// the row was hardcoded in Integration.tsx even though the backend
// and API client had already moved into the plugin (3E.2).

import { useState } from "react";
import { useApi } from "@vonzio/dashboard/hooks/useApi";
import { Button } from "@vonzio/dashboard/brand/components";
import type { IntegrationRowSlotProps } from "@vonzio/dashboard/registry";
import { fetchSlackConfig, getSlackAuthorizeUrl } from "./api.js";

export function SlackIntegrationRow({
  integrations,
  openScopeEditor,
  handleSetDefault,
  handleTest,
  testResult,
  testingId,
  scopeSummary,
  refetch,
}: IntegrationRowSlotProps) {
  const { data: slackConfig } = useApi<{ enabled: boolean }>(() => fetchSlackConfig());
  const slack = integrations.find((i) => i.type === "slack");
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    setConnecting(true);
    try {
      const { url } = await getSlackAuthorizeUrl("/settings");
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!slack) return;
    const res = await fetch(`/v1/integrations/${slack.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) refetch();
  }

  return (
    <Row
      badgeBg="#4A154B"
      badgeChar="S"
      name="Slack"
      value={slack ? ((slack.config.team_name as string) ?? "Connected") : "Not connected"}
      isDefault={slack?.is_default}
      actions={
        slack ? (
          <>
            {!slack.is_default && (
              <Button variant="ghost" size="sm" onClick={() => handleSetDefault(slack.id)}>
                Set default
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => openScopeEditor(slack.id)}>
              Scope: {scopeSummary(slack)}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleTest(slack.id)} disabled={testingId === slack.id}>
              {testingId === slack.id ? "Sending…" : "Test"}
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </>
        ) : slackConfig?.enabled ? (
          <Button size="sm" onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Slack"}
          </Button>
        ) : (
          // Slack OAuth requires SLACK_CLIENT_ID + SLACK_CLIENT_SECRET
          // env vars on the server. When they aren't set, surface the
          // reason explicitly -- matches Teller's "not configured by
          // admin" treatment so the row doesn't look broken.
          <span style={{ fontSize: 12, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
            not configured by admin
          </span>
        )
      }
      testResult={testResult?.id === slack?.id ? testResult : undefined}
    />
  );
}

// Local row component mirroring dashboard's IntegrationRow visual.
// Inlined so the plugin doesn't depend on Integration.tsx's internal
// component; same shape so plugin + hardcoded rows align visually.
function Row({
  badgeBg,
  badgeChar,
  name,
  value,
  isDefault,
  actions,
  testResult,
}: {
  badgeBg: string;
  badgeChar: string;
  name: string;
  value: React.ReactNode;
  isDefault?: boolean;
  actions: React.ReactNode;
  testResult?: { id: string; status: "success" | "error"; message: string } | null;
}) {
  return (
    <div style={{ padding: 16, borderBottom: "1px solid var(--vz-border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "var(--vz-radius-md)",
              background: badgeBg,
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 700,
              fontSize: 13,
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {badgeChar}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 500, color: "var(--vz-ink)", fontSize: 13.5 }}>{name}</span>
              {isDefault && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "var(--vz-info-bg, rgba(59,130,246,0.15))",
                    color: "var(--vz-info, #3b82f6)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  default
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", marginTop: 2 }}>{value}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{actions}</div>
      </div>
      {testResult && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11.5,
            fontFamily: "var(--vz-font-mono)",
            color: testResult.status === "success" ? "var(--vz-ok)" : "var(--vz-fail)",
          }}
        >
          {testResult.message}
        </div>
      )}
    </div>
  );
}

// Telegram's contribution to the dashboard's IntegrationRow slot.
// Shows summary state ("N bots connected, default @..." or
// "Not connected") inside Settings > Integrations > Notifications &
// chat. Opens the existing TelegramSettings UI in a Modal when the
// user clicks "Manage".
//
// Phase 3G: replaces the standalone /settings#telegram tab with a
// row + drawer pattern so all chat-surface plugins share the same
// surface in Settings. Mirrors slack's SlackIntegrationRow shape.

import { useState } from "react";
import { useApi } from "@vonzio/dashboard/hooks/useApi";
import { Button, Modal } from "@vonzio/dashboard/brand/components";
import type { IntegrationRowSlotProps } from "@vonzio/dashboard/registry";
import { fetchTelegramBots, fetchTelegramConfig, type TelegramBot, type TelegramConfigInfo } from "./api.js";
import { TelegramSettings } from "./TelegramSettings.js";

export function TelegramIntegrationRow({
  integrations,
  testResult,
}: IntegrationRowSlotProps) {
  const { data: botsData, refetch } = useApi<{ bots: TelegramBot[] }>(() => fetchTelegramBots());
  const { data: telegramConfig } = useApi<TelegramConfigInfo>(() => fetchTelegramConfig());
  const [drawerOpen, setDrawerOpen] = useState(false);

  const bots = botsData?.bots ?? [];
  const linked = bots.filter((b) => b.linked);
  // The user's "default" telegram integration row -- the
  // notification-service routes outbound notifies to it.
  const defaultIntegration = integrations.find(
    (i) => i.type === "telegram" && i.is_default,
  );
  const defaultBot = defaultIntegration
    ? linked.find((b) => b.id === defaultIntegration.id)
    : undefined;

  let value: string;
  if (bots.length === 0) {
    value = telegramConfig?.platformBot
      ? `Not connected — one-tap pair with @${telegramConfig.platformBot.bot_username} or bring your own bot`
      : "Not connected";
  } else if (defaultBot) {
    value = `${linked.length} bot${linked.length === 1 ? "" : "s"} · default @${defaultBot.bot_username}`;
  } else {
    value = `${bots.length} bot${bots.length === 1 ? "" : "s"} (${linked.length} linked)`;
  }

  function handleClose() {
    setDrawerOpen(false);
    // Refresh the summary when the user closes the drawer in case
    // they added/removed bots.
    refetch();
  }

  // Local test-result echo for the row when a Test action inside the
  // drawer targets a telegram bot. Drawer-contained interactions own
  // their own state, so the row only renders a brief inline hint when
  // the parent's testResult points at a bot we know about.
  const testForUs = testResult && bots.some((b) => b.id === testResult.id) ? testResult : undefined;

  return (
    <>
      <Row
        badgeBg="#229ED9"
        badgeChar="T"
        name="Telegram"
        value={value}
        isDefault={!!defaultBot}
        actions={
          <>
            <Button
              size="sm"
              variant={bots.length === 0 ? "primary" : "ghost"}
              onClick={() => setDrawerOpen(true)}
              disabled={!telegramConfig?.publicReachable}
            >
              {telegramConfig?.publicReachable
                ? bots.length === 0
                  ? "Connect"
                  : "Manage"
                : "Public URL required"}
            </Button>
          </>
        }
        testResult={testForUs}
      />

      <Modal
        open={drawerOpen}
        onClose={handleClose}
        size="xl"
        dismissable
        title="Telegram"
        description="Connect Telegram bots to your sessions and playbooks."
      >
        <TelegramSettings />
      </Modal>
    </>
  );
}

// Local row component matching dashboard's IntegrationRow visual.
// Inlined so the plugin doesn't depend on Integration.tsx's internal
// component; identical shape to slack's row helper.
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
            <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", marginTop: 2 }}>
              {value}
            </div>
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

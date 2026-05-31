// @vonzio/plugin-telegram -- frontend half.
//
// POC SCAFFOLD: registers a placeholder settings section so the
// dashboard plugin-loader wiring is observable end-to-end. Real
// Telegram settings UI (token input, bot list, connect/disconnect,
// etc.) lands in a follow-up of the 3C extraction arc.
//
// Plugins export a default function that the dashboard plugin loader
// calls once at boot. The function imports whatever it needs from
// `@vonzio/dashboard/registry` -- which already supports settings
// sections, nav items, topbar/composer/workspace-header slots,
// onboarding steps, routes, user-menu items -- and registers UI for
// those slots.

import type { ReactElement } from "react";
import { registerSettingsSection } from "@vonzio/dashboard/registry/api";
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";

function TelegramSettingsCard(): ReactElement {
  return (
    <div data-testid="plugin-telegram-settings">
      <h3>Telegram (plugin scaffold)</h3>
      <p>
        Telegram integration is moving to <code>@vonzio/plugin-telegram</code>.
        This is a placeholder card -- the real connect / disconnect /
        bot-list UI lands in a follow-up of the 3C extraction arc.
      </p>
    </div>
  );
}

const register: PluginFrontendEntry = () => {
  registerSettingsSection({
    id: "telegram",
    label: "Telegram",
    lede: "Connect Telegram bots to your sessions and playbooks.",
    component: TelegramSettingsCard,
    order: 80,
  });
};

export default register;

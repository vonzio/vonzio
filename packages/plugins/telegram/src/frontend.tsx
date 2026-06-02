// @vonzio/plugin-telegram -- frontend half.
//
// Registers two dashboard slots:
//   1. SettingsSection at /settings#telegram -- the full Telegram bot
//      list + connect/disconnect/scope/test/set-default UI. Moved here
//      from packages/dashboard/src/pages/settings/sections/Integration.tsx
//      in Phase 3D.1e.
//   2. WorkspaceHeaderSlot -- the "Open in Telegram" deep-link button
//      shown in the workspace header when the user has a linked bot.
//      Moved here from packages/dashboard/src/components/WorkspaceHeader.tsx.
//
// Both consume the plugin-owned API client in ./dashboard/api.ts which
// targets the plugin-served /v1/integrations/telegram/* routes.

import { registerSettingsSection, registerWorkspaceHeaderSlot } from "@vonzio/dashboard/registry/api";
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";
import { TelegramSettings } from "./dashboard/TelegramSettings.js";
import { WorkspaceHeaderTelegramButton } from "./dashboard/WorkspaceHeaderTelegramButton.js";

const register: PluginFrontendEntry = () => {
  registerSettingsSection({
    id: "telegram",
    label: "Telegram",
    lede: "Connect Telegram bots to your sessions and playbooks.",
    component: TelegramSettings,
    order: 80,
  });
  registerWorkspaceHeaderSlot({
    id: "telegram",
    component: WorkspaceHeaderTelegramButton,
    order: 50,
  });
};

export default register;

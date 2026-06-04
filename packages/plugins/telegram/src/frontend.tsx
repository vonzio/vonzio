// @vonzio/plugin-telegram -- frontend half.
//
// Registers two dashboard slots:
//   1. IntegrationRow at Settings > Integrations > Notifications &
//      chat -- shows a compact summary ("N bots connected, default
//      @x") with a "Manage" button that opens the full bot list /
//      connect / QR / scope UI in a modal. Phase 3G demoted this
//      from a standalone /settings#telegram tab to a row-and-drawer
//      so every chat-surface plugin shares one consistent surface
//      in Settings. Slack uses the same slot.
//   2. WorkspaceHeaderSlot -- the "Open in Telegram" deep-link
//      button shown in the workspace header when the user has a
//      linked bot. Moved here from
//      packages/dashboard/src/components/WorkspaceHeader.tsx in
//      Phase 3D.1e.
//
// Both consume the plugin-owned API client in ./dashboard/api.ts.

import { registerIntegrationRow, registerWorkspaceHeaderSlot } from "@vonzio/dashboard-registry/api";
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";
import { TelegramIntegrationRow } from "./dashboard/TelegramIntegrationRow.js";
import { WorkspaceHeaderTelegramButton } from "./dashboard/WorkspaceHeaderTelegramButton.js";

const register: PluginFrontendEntry = () => {
  registerIntegrationRow({
    id: "telegram",
    component: TelegramIntegrationRow,
    section: "notifications",
    // Land just before slack (slack at 110) so Telegram appears
    // first under the hardcoded Email/Webhook rows. Hardcoded rows
    // occupy 10-100 implicitly.
    order: 105,
  });
  registerWorkspaceHeaderSlot({
    id: "telegram",
    component: WorkspaceHeaderTelegramButton,
    order: 50,
  });
};

export default register;

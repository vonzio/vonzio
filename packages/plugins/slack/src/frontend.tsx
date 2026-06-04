// @vonzio/plugin-slack -- frontend half.
//
// Contributes a row to the dashboard's Settings > Integrations >
// Notifications & chat section via the registerIntegrationRow slot
// (added in Phase 3F.1). Before this, the row was hardcoded in
// dashboard's Integration.tsx -- the plugin model now extends to UI
// placement too.

import { registerIntegrationRow } from "@vonzio/dashboard-registry/api";
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";
import { SlackIntegrationRow } from "./dashboard/SlackIntegrationRow.js";

const register: PluginFrontendEntry = () => {
  registerIntegrationRow({
    id: "slack",
    component: SlackIntegrationRow,
    section: "notifications",
    // Land at the top of the section (below hardcoded rows which
    // implicitly land at order 10-100).
    order: 110,
  });
};

export default register;

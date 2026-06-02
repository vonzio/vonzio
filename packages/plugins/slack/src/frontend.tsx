// @vonzio/plugin-slack -- frontend half.
//
// Empty no-op for Phase 3E.1. Slack has minimal dashboard UI (one
// "Connect Slack" button in the Integrations tab) compared to
// Telegram -- there's no bot list, QR flow, or scope/test surface
// to extract. 3E.3 moves the dashboard API client into the plugin
// and rewires the Integrations row to use it; whether to graduate
// the row into a registry slot is a UX call deferred to a later
// phase (would also benefit Email + Webhook).

import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";

const register: PluginFrontendEntry = () => {
  // Intentionally empty -- see file header.
};

export default register;

import { GitSection } from "./Git.js";
import { IntegrationSection } from "./Integration.js";

/**
 * Combined Settings → Integrations tab.
 *
 * Git providers (cloning credentials) and OAuth-bearing integrations
 * (Slack / Gmail / Telegram / Teller / Email / Webhook) used to live in
 * separate Settings tabs but they're conceptually the same surface:
 * "third-party providers your agents can talk to". Stacking them under
 * one tab matches the user's mental model and (when shared at the org
 * level via org_integration_grants) keeps the management story
 * coherent — see /org/settings → Integrations on the SaaS side.
 *
 * Git providers render FIRST because code agents need them to clone
 * anything; the OAuth notifications/data block sits below.
 */
export function IntegrationsAndGitSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <GitSection />
      <IntegrationSection />
    </div>
  );
}

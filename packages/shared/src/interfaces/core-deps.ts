import type { ProfileResolver } from "./profile-resolver.js";
import type { IntegrationCredentials } from "./integration-credentials.js";
import type { SecretVault } from "./secret-vault.js";
import type { TokenValidator } from "./token-validator.js";
import type { QuotaConfig } from "./quota-config.js";
import type { UsageEmitter } from "./usage-emitter.js";
import type { EntitlementsProvider } from "./entitlements-provider.js";
import type { VpnTunnelProvider } from "./vpn-tunnel-provider.js";

/**
 * The six seam dependencies that every consumer in the runtime (orchestrator,
 * services, routes) takes via constructor injection. core-server constructs
 * these with default in-process implementations at boot. cp-server (when
 * present) builds its own registry and replaces individual fields before
 * mounting onto core-server. Plain object — same shape as OrchestratorDeps
 * and ServerDeps elsewhere in the codebase.
 */
export interface CoreDeps {
  profileResolver: ProfileResolver;
  integrationCredentials: IntegrationCredentials;
  secretVault: SecretVault;
  tokenValidator: TokenValidator;
  quotaConfig: QuotaConfig;
  usageEmitter: UsageEmitter;
  entitlementsProvider: EntitlementsProvider;
  vpnTunnelProvider: VpnTunnelProvider;
  /**
   * Optional — fired after a task is submitted so a SaaS layer can
   * link the task to an org (cp-server stores this in its task_orgs
   * side-table). OSS deployments leave this undefined; tasks then
   * have no org affinity and downstream workspace inserts get
   * org_id=null (OSS doesn't have the NOT NULL CHECK).
   */
  recordTaskOrg?: (taskId: string, orgId: string) => Promise<void>;
  /**
   * Optional — fired by the orchestrator before launching a workspace
   * for a task. Returns the org_id (if any) the task should be tagged
   * with. cp-server resolves it from task_orgs; OSS returns null
   * (kept undefined so the orchestrator skips the call).
   */
  resolveOrgIdForTask?: (taskId: string) => Promise<string | null>;
}

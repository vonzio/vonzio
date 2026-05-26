import type { ProfileResolver } from "./profile-resolver.js";
import type { IntegrationCredentials } from "./integration-credentials.js";
import type { SecretVault } from "./secret-vault.js";
import type { TokenValidator } from "./token-validator.js";
import type { QuotaConfig } from "./quota-config.js";
import type { UsageEmitter } from "./usage-emitter.js";
import type { EntitlementsProvider } from "./entitlements-provider.js";

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
}

import type { CoreDeps } from "@vonzio/shared";
import type { DrizzleDB } from "../db/index.js";
import type { ProfileService } from "../services/profile-service.js";
import type { SecretVaultService } from "../services/secret-vault-service.js";
import type { IntegrationService } from "../services/integration-service.js";
import { DefaultTokenValidator } from "./defaults/token-validator.js";
import { DefaultIntegrationCredentials } from "./defaults/integration-credentials.js";
import { DefaultQuotaConfig } from "./defaults/quota-config.js";
import { NoopUsageEmitter } from "./defaults/usage-emitter.js";

export interface CoreDepsServices {
  db: DrizzleDB;
  profileService: ProfileService;
  secretVaultService: SecretVaultService;
  integrationService: IntegrationService;
}

/**
 * Build the six-seam CoreDeps registry with default in-process
 * implementations. ProfileService and SecretVaultService satisfy
 * the seam interfaces structurally and pass through directly;
 * IntegrationService needs an adapter for the shape difference;
 * TokenValidator/QuotaConfig/UsageEmitter are stand-alone defaults.
 *
 * cp-server consumes this and can swap individual fields before
 * passing the registry into the runtime.
 */
export function buildDefaultCoreDeps(services: CoreDepsServices): CoreDeps {
  return {
    profileResolver: services.profileService,
    secretVault: services.secretVaultService,
    integrationCredentials: new DefaultIntegrationCredentials(services.integrationService),
    tokenValidator: new DefaultTokenValidator(services.db),
    quotaConfig: new DefaultQuotaConfig(),
    usageEmitter: new NoopUsageEmitter(),
  };
}

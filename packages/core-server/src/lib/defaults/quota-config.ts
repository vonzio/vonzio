import type { QuotaConfig, QuotaLimits } from "@vonzio/shared";

/**
 * Default quota config — returns static defaults since OSS has no
 * user-level quotas (a single user owns the instance). Per-profile
 * concurrency lives on the profile row; per-token rpm lives on the
 * api_tokens row. cp-server overrides this with a plan-aware impl.
 */
export class DefaultQuotaConfig implements QuotaConfig {
  async getLimits(_userId: string): Promise<QuotaLimits> {
    return {
      concurrency: null,
      rpm: null,
      monthlyTokensUsd: null,
    };
  }
}

export interface QuotaLimits {
  /** null means unlimited (OSS default). */
  concurrency: number | null;
  /** null means unlimited (OSS default). */
  rpm: number | null;
  /** null means unlimited (OSS default). */
  monthlyTokensUsd: number | null;
}

/**
 * Returns the enforced limits for a given user. Default implementation
 * reads from profile defaults; a control-plane implementation reads from
 * `subscriptions` / `plans`.
 */
export interface QuotaConfig {
  getLimits(userId: string): Promise<QuotaLimits>;
}

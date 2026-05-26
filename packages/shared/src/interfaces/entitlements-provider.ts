/**
 * Minimal user shape passed to the entitlements provider. Subset of the
 * Better Auth session user — wide enough for plan/role gating decisions,
 * narrow enough that the seam doesn't pull the full auth schema into
 * shared.
 */
export interface EntitlementsUser {
  id: string;
  email: string;
  role?: string | null;
  /** Sparse comma-separated flag string (existing OSS convention). */
  featureFlags?: string | null;
}

/**
 * Computes the entitlements active for a given user. The dashboard uses
 * the returned strings to gate routes, nav items, and settings sections;
 * the codebase treats entitlements as opaque tokens (no "Pro"/"Admin"
 * literals in OSS code).
 *
 * Default implementation in core-server returns ["self_hosted"] plus
 * "admin" / "admin_multitenant" derived from role and config.
 * cp-server replaces this with a provider that reads plan/billing/SSO
 * state from the SaaS database.
 */
export interface EntitlementsProvider {
  compute(user: EntitlementsUser): Promise<string[]>;
}

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
  /**
   * Optional — given a user + the active org, return the set of
   * user_secrets row ids that should be HIDDEN. cp-server uses this
   * to hide team-shared secrets (materialized from a different org's
   * org_secrets) when the active org isn't that team. OSS returns an
   * empty set; the user sees all their user_secrets rows uniformly.
   */
  hiddenUserSecretIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
  ) => Promise<Set<string>>;
  /**
   * Optional — fired after a profile is created so cp-server can link
   * it to the active org in profile_orgs. OSS leaves this undefined;
   * profiles then have no org affinity (existing OSS behaviour).
   */
  recordProfileOrg?: (profileId: string, orgId: string) => Promise<void>;
  /**
   * Optional — fired after a profile is deleted so cp-server can drop
   * its profile_orgs row. OSS leaves this undefined; the row never
   * existed anyway.
   */
  forgetProfileOrg?: (profileId: string) => Promise<void>;
  /**
   * Optional — given a user, the active org, and the candidate set of
   * profile ids the user owns / has access to, return the subset that
   * should be VISIBLE in the active org. Returning `null` means "no
   * filter applies" (OSS / no active-org context). Returning a Set
   * means "include only these ids".
   */
  visibleProfileIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
    candidateProfileIds: string[],
  ) => Promise<Set<string> | null>;
  /**
   * Optional — returns true when the given profile_id is a row that
   * cp-server materialized from an org_profile (team-shared agent).
   * OSS PATCH/DELETE /v1/profiles/:id rejects with 403 when this is
   * true; the row is read-only to members (owner edits via
   * /api/orgs/:slug/profiles instead).
   */
  isMaterializedOrgProfile?: (profileId: string) => Promise<boolean>;
  /**
   * Optional — batch variant of `isMaterializedOrgProfile`. Returns
   * the subset of `profileIds` that are materialized org_profiles.
   * Used by GET /v1/profiles to tag each row with `team_owned: true`
   * so the dashboard can segment "Your agents" vs "Team agents".
   */
  materializedOrgProfileIds?: (profileIds: string[]) => Promise<Set<string>>;
}

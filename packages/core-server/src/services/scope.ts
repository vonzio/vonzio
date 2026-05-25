/**
 * Shared scope primitive for resources that can either be "available to all
 * agents owned by a user" or "restricted to a specific list of profiles."
 * Used today by user_secrets and user_integrations; the shape (scope enum +
 * profile_ids array) is identical on both tables.
 *
 * The caller (route layer) is responsible for the ownership check that every
 * id in profile_ids actually belongs to the requesting user — this module
 * only validates shape, not authorization.
 */

export type Scope = "all" | "agents";

export interface ScopeInput {
  scope?: Scope;
  profile_ids?: string[];
}

export function normalizeScope(input: ScopeInput): { scope: Scope; profile_ids: string[] } {
  const scope = input.scope ?? "all";
  if (scope !== "all" && scope !== "agents") {
    throw new Error("scope must be 'all' or 'agents'");
  }
  if (scope === "all") return { scope: "all", profile_ids: [] };
  const ids = input.profile_ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("scope 'agents' requires a non-empty profile_ids");
  }
  for (const pid of ids) {
    if (typeof pid !== "string" || !pid) {
      throw new Error("profile_ids must contain non-empty strings");
    }
  }
  return { scope: "agents", profile_ids: Array.from(new Set(ids)) };
}

/** Is a row scoped to this profile? scope='all' always grants. */
export function isGrantedToProfile(row: { scope: Scope; profile_ids: string[] }, profileId: string): boolean {
  return row.scope === "all" || (row.profile_ids ?? []).includes(profileId);
}

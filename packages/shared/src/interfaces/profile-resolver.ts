import type { ResolvedProfile } from "../types/profile.js";

/**
 * Resolves a profile id to a fully-loaded, credential-decrypted snapshot.
 * The default implementation reads the `profiles` table and decrypts via
 * the integration service. A control-plane implementation may layer
 * plan-based limits on top of the resolved profile.
 */
export interface ProfileResolver {
  getResolved(profileId: string): Promise<ResolvedProfile | null>;
}

import type {
  IntegrationCredentials,
  ResolvedIntegration,
} from "@vonzio/shared";
import type { IntegrationService } from "../../services/integration-service.js";

/**
 * Adapter from IntegrationService (which returns the wider `Integration`
 * shape with scope/profile_ids/timestamps) to the seam's narrower
 * ResolvedIntegration. The orchestrator only needs id/type/user_id/
 * profile_id/config/enabled at runtime — scope/profile_ids were the
 * mechanism for the scope filter, which `listForProfile` already applied.
 *
 * `profile_id` on the result reflects the queried profile when the
 * integration was scope='agents' for that profile, or null when the
 * integration was scope='all'.
 */
export class DefaultIntegrationCredentials implements IntegrationCredentials {
  constructor(private integrations: IntegrationService) {}

  async listForProfile(
    userId: string,
    type: string,
    profileId: string,
  ): Promise<ResolvedIntegration[]> {
    const rows = await this.integrations.listForProfile(userId, type, profileId);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      user_id: r.user_id,
      profile_id: r.scope === "agents" ? profileId : null,
      config: r.config,
      enabled: r.enabled,
    }));
  }
}

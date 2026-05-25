/**
 * A user's connected integration with its credentials already decrypted.
 * `config` shape depends on `type` (slack, gmail, telegram, teller).
 */
export interface ResolvedIntegration {
  id: string;
  type: string;
  user_id: string;
  profile_id: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

/**
 * Fetches a user's connected integrations with credentials decrypted.
 * Used by the orchestrator/MCP plugins at task runtime. `profileId` must
 * resolve to a real profile — the orchestrator never asks without one.
 */
export interface IntegrationCredentials {
  listForProfile(
    userId: string,
    type: string,
    profileId: string,
  ): Promise<ResolvedIntegration[]>;
}

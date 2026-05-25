export interface ValidatedToken {
  userId: string;
  tokenId: string;
  /** Human-readable label the user gave the token at issuance — used for logs/audit. */
  tokenName: string;
  /** Profile ids the token is scoped to. Empty array = no profiles allowed. */
  allowedProfileIds: string[];
  rateLimitRpm: number;
}

/**
 * Validates a bearer token presented on an inbound API request.
 * Default implementation: hashed lookup against the `api_tokens` table.
 * Replaces the legacy full-table-scan in auth/user-auth.ts.
 */
export interface TokenValidator {
  validate(bearerToken: string): Promise<ValidatedToken | null>;
}

import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import type { TokenValidator, ValidatedToken } from "@vonzio/shared";
import type { DrizzleDB } from "../../db/index.js";
import { schema } from "../../db/index.js";

/**
 * Default in-process token validator. Scans the api_tokens table and
 * runs bcrypt.compare against each row — O(n) with a slow per-row hash.
 *
 * Replaces the inline scan that lived in auth/user-auth.ts before the
 * seam was extracted. A future optimization should switch to a fast
 * hash (e.g., sha-256 with a peppered prefix) so we can index by the
 * hash and skip the loop entirely. Left as-is here to avoid changing
 * token-issuance behavior in PR 2.
 */
export class DefaultTokenValidator implements TokenValidator {
  constructor(private db: DrizzleDB) {}

  async validate(bearerToken: string): Promise<ValidatedToken | null> {
    const rows = await this.db.select().from(schema.apiTokens);
    for (const row of rows) {
      const match = await bcrypt.compare(bearerToken, row.key_hash);
      if (!match) continue;
      await this.db
        .update(schema.apiTokens)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(schema.apiTokens.id, row.id));
      return {
        userId: row.user_id ?? "",
        tokenId: row.id,
        tokenName: row.name,
        allowedProfileIds: row.allowed_profile_ids,
        rateLimitRpm: row.rate_limit_rpm,
      };
    }
    return null;
  }
}

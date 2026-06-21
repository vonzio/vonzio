import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import bcrypt from "bcrypt";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

export interface CreateApiTokenInput {
  name: string;
  userId: string;
  allowedProfileIds?: string[];
  rateLimitRpm?: number;
}

/**
 * Mint an API token: generate the plaintext, bcrypt-hash it for storage, and
 * insert the row. Returns the row id and the **plaintext token** (shown once —
 * only the hash is persisted). Shared by `POST /v1/api-tokens` and the device
 * flow so both produce identical, validator-compatible tokens.
 */
export async function createApiToken(
  db: DrizzleDB,
  input: CreateApiTokenInput,
): Promise<{ id: string; token: string }> {
  const token = `rc_${randomBytes(24).toString("hex")}`;
  const hash = await bcrypt.hash(token, 10);
  const id = `key_${nanoid()}`;
  await db.insert(schema.apiTokens).values({
    id,
    name: input.name,
    key_hash: hash,
    user_id: input.userId,
    allowed_profile_ids: input.allowedProfileIds ?? [],
    rate_limit_rpm: input.rateLimitRpm ?? 60,
    created_at: new Date().toISOString(),
    last_used_at: null,
  });
  return { id, token };
}

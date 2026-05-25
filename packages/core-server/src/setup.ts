import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { loadConfig } from "./config.js";
import { eq } from "drizzle-orm";
import { createDB } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { schema } from "./db/index.js";
import { encrypt } from "./auth/crypto.js";
import { slugify } from "./services/slug.js";
import { nanoid } from "nanoid";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig();
  const handle = createDB(config.DATABASE_URL);
  await runMigrations(handle);

  try {
    switch (command) {
      case "create-key": {
        await createCallerKey(handle.db, args[1]);
        break;
      }
      case "add-profile": {
        await addProfile(handle.db, config.ENCRYPTION_KEY, args[1], args[2]);
        break;
      }
      case "update-profile": {
        await updateProfile(handle.db, config.ENCRYPTION_KEY, args[1], args[2]);
        break;
      }
      case "list-profiles": {
        await listProfiles(handle.db);
        break;
      }
      case "bootstrap": {
        const keyName = args[1] || "default";
        const anthropicKey = args[2];
        if (!anthropicKey) {
          console.error("Usage: setup bootstrap [key-name] <ANTHROPIC_API_KEY>");
          process.exit(1);
        }
        const { callerToken, profileId } = await bootstrap(
          handle.db,
          config.ENCRYPTION_KEY,
          keyName,
          anthropicKey,
        );
        console.log("\n=== Vonzio Bootstrap Complete ===\n");
        console.log(`Caller API Key: ${callerToken}`);
        console.log(`Profile ID:     ${profileId}`);
        console.log("\nUse the caller key in the Authorization header:");
        console.log(`  curl -H "Authorization: Bearer ${callerToken}" http://localhost:${config.PORT}/v1/tasks`);
        console.log(`\nSubmit a task:`);
        console.log(`  curl -X POST http://localhost:${config.PORT}/v1/tasks \\`);
        console.log(`    -H "Authorization: Bearer ${callerToken}" \\`);
        console.log(`    -H "Content-Type: application/json" \\`);
        console.log(`    -d '{"prompt": "Hello, what can you do?", "profile_id": "${profileId}"}'`);
        break;
      }
      default: {
        console.log("Vonzio Setup\n");
        console.log("Commands:");
        console.log("  bootstrap [name] <ANTHROPIC_API_KEY>  — Create caller key + profile in one step");
        console.log("  create-key [name]                     — Create a new caller API key");
        console.log("  add-profile <name> <ANTHROPIC_KEY> — Add an Anthropic API key profile");
        console.log("  update-profile <id> <ANTHROPIC_KEY> — Update an existing profile's API key");
        console.log("  list-profiles                      — List all profiles (keys redacted)");
        break;
      }
    }
  } finally {
    await handle.close();
  }
}

async function createCallerKey(
  db: ReturnType<typeof createDB>["db"],
  name?: string,
): Promise<string> {
  const token = `rc_${randomBytes(24).toString("hex")}`;
  const hash = await bcrypt.hash(token, 10);
  const id = `key_${nanoid()}`;

  await db.insert(schema.apiTokens)
    .values({
      id,
      name: name || "default",
      key_hash: hash,
      allowed_profile_ids: [], // Will be updated after profile creation
      rate_limit_rpm: 60,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  console.log(`Caller API key created: ${token}`);
  console.log(`  ID: ${id}`);
  console.log(`  Name: ${name || "default"}`);
  return token;
}

async function addProfile(
  db: ReturnType<typeof createDB>["db"],
  encryptionKey: string,
  name?: string,
  apiKey?: string,
): Promise<string> {
  if (!name || !apiKey) {
    console.error("Usage: setup add-profile <name> <ANTHROPIC_API_KEY>");
    process.exit(1);
  }

  // Create API key first
  const akId = `apk_${nanoid()}`;
  await db.insert(schema.anthropicKeys)
    .values({
      id: akId,
      name: name + " Key",
      provider: "api_key",
      encrypted_api_key: encrypt(apiKey, encryptionKey),
      encrypted_auth_token: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  const id = `prof_${nanoid()}`;
  await db.insert(schema.profiles)
    .values({
      id,
      name,
      slug: slugify(name),
      api_key_id: akId,
      default_tools: [],
      default_egress_domains: [],
      claude_md: null,
      concurrency_limit: 5,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  console.log(`Profile created: ${id}`);
  console.log(`  Name: ${name}`);
  return id;
}

async function bootstrap(
  db: ReturnType<typeof createDB>["db"],
  encryptionKey: string,
  keyName: string,
  anthropicKey: string,
): Promise<{ callerToken: string; profileId: string }> {
  // Create API key
  const akId = `apk_${nanoid()}`;
  await db.insert(schema.anthropicKeys)
    .values({
      id: akId,
      name: keyName + " Key",
      provider: "api_key",
      encrypted_api_key: encrypt(anthropicKey, encryptionKey),
      encrypted_auth_token: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  // Create profile
  const profileId = `prof_${nanoid()}`;
  await db.insert(schema.profiles)
    .values({
      id: profileId,
      name: keyName,
      slug: slugify(keyName),
      api_key_id: akId,
      default_tools: [],
      default_egress_domains: [],
      claude_md: null,
      concurrency_limit: 5,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  // Create caller key with access to this profile
  const callerToken = `rc_${randomBytes(24).toString("hex")}`;
  const hash = await bcrypt.hash(callerToken, 10);
  const keyId = `key_${nanoid()}`;

  await db.insert(schema.apiTokens)
    .values({
      id: keyId,
      name: keyName,
      key_hash: hash,
      allowed_profile_ids: [profileId],
      rate_limit_rpm: 60,
      created_at: new Date().toISOString(),
      last_used_at: null,
    });

  return { callerToken, profileId };
}

async function updateProfile(
  db: ReturnType<typeof createDB>["db"],
  encryptionKey: string,
  profileId?: string,
  newApiKey?: string,
): Promise<void> {
  if (!profileId || !newApiKey) {
    console.error("Usage: setup update-profile <profile_id> <NEW_ANTHROPIC_API_KEY>");
    process.exit(1);
  }

  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.id, profileId));

  if (rows.length === 0) {
    console.error(`Profile ${profileId} not found`);
    process.exit(1);
  }

  // Get the profile's linked api_key_id and update that
  const profile = await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId));
  const apiKeyId = profile[0]?.api_key_id;
  if (apiKeyId) {
    await db.update(schema.anthropicKeys)
      .set({ encrypted_api_key: encrypt(newApiKey, encryptionKey) })
      .where(eq(schema.anthropicKeys.id, apiKeyId));
    console.log(`API key ${apiKeyId} updated for profile ${profileId}`);
  } else {
    console.error(`Profile ${profileId} has no linked API key`);
    process.exit(1);
  }
}

async function listProfiles(
  db: ReturnType<typeof createDB>["db"],
): Promise<void> {
  const rows = await db.select().from(schema.profiles);

  if (rows.length === 0) {
    console.log("No profiles found");
    return;
  }

  console.log("\nProfiles:\n");
  for (const row of rows) {
    console.log(`  ID:       ${row.id}`);
    console.log(`  Name:     ${row.name}`);
    console.log(`  API Key:  ${row.api_key_id ?? "—"}`);
    console.log(`  Created:  ${row.created_at}`);
    console.log();
  }
}

main();

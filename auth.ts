/**
 * Schema-only Better Auth config used by the @better-auth/cli for
 * generating + applying the Better Auth tables (user, session, account,
 * verification) to a fresh database.
 *
 * The runtime app does NOT import this — it uses createAuth() in
 * packages/core-server/src/auth/better-auth.ts with the full plugin
 * stack. This standalone file mirrors only what the CLI needs to emit
 * the right DDL:
 *  - the same database connection (so it migrates the right DB)
 *  - the same plugins that add columns (admin -> user.role/banned, etc.)
 *  - the same `user.additionalFields` (role, feature_flags) so they are
 *    included in the generated table.
 *
 * Run with:
 *   npx @better-auth/cli@latest migrate -y --config auth.ts
 *
 * Or for a fresh OSS dev DB:
 *   make better-auth-migrate
 */
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: databaseUrl });

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET ?? "cli-migrate-placeholder-secret-min-32-x",
  emailAndPassword: { enabled: true },
  plugins: [admin()],
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user" },
      feature_flags: { type: "string", defaultValue: "" },
    },
  },
});

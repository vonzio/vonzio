/**
 * User-facing routes for tools, skills, subagents, and git providers.
 * Users see their own resources + shared (user_id=NULL) resources.
 * Admin sees all.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

/** Check resource ownership: resource must exist and belong to user (or user is admin). Returns false if unauthorized. */
function canAccess(user: { id: string; role: string }, resourceUserId: string | null | undefined): boolean {
  if (user.role === "admin") return true;
  if (resourceUserId === null || resourceUserId === undefined) return true; // shared resource
  return user.id === resourceUserId;
}
import type { ToolFileService } from "../services/tool-file-service.js";
import type { SkillService } from "../services/skill-service.js";
import type { SubagentService } from "../services/subagent-service.js";
import type { GitProviderService } from "../services/git-provider-service.js";
import type { ApiKeyService } from "../services/api-key-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { SecretVaultService } from "../services/secret-vault-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface UserResourceRoutesOptions {
  db: DrizzleDB;
  apiKeyService: ApiKeyService;
  profileService: ProfileService;
  toolFileService: ToolFileService;
  skillService: SkillService;
  subagentService: SubagentService;
  gitProviderService: GitProviderService;
  secretVaultService: SecretVaultService;
  /**
   * Optional SaaS hook — given userId + the ALS-pinned active org,
   * returns the set of user_secret ids to hide from the response.
   * cp-server hides materialized rows whose source org_secret doesn't
   * belong to the active org, preventing cross-tenant leak. OSS
   * leaves this undefined; the user sees all their secrets.
   */
  hiddenUserSecretIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
  ) => Promise<Set<string>>;
}

export const userResourceRoutes = fp(
  async (server: FastifyInstance, opts: UserResourceRoutesOptions) => {
    const { db, apiKeyService, profileService, toolFileService, skillService, subagentService, gitProviderService, secretVaultService } = opts;

    // ─── Tools ──────────────────────────────────────────────
    server.get("/v1/tools", async (request) => {
      const user = request.user!;
      return toolFileService.list(user.id);
    });

    server.post("/v1/tools", async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body.name || !body.code) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and code are required"));
      }
      const tool = await toolFileService.upload({
        name: body.name as string,
        description: body.description as string | undefined,
        file_name: (body.file_name as string) ?? `${body.name}.js`,
        code: body.code as string,
        input_schema: body.input_schema as string | undefined,
      }, request.user!.id);
      return reply.code(201).send(tool);
    });

    server.delete<{ Params: { id: string } }>("/v1/tools/:id", async (request, reply) => {
      const rows = await db.select().from(schema.toolFiles).where(eq(schema.toolFiles.id, request.params.id));
      if (!rows.length || !canAccess(request.user!, rows[0].user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Tool not found"));
      }
      await toolFileService.delete(request.params.id);
      return { status: "deleted" };
    });

    // ─── Skills ─────────────────────────────────────────────
    server.get("/v1/skills", async (request) => {
      const user = request.user!;
      return skillService.list(user.id);
    });

    server.post("/v1/skills", async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body.name || !body.content) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and content are required"));
      }
      const skill = await skillService.upload({
        name: body.name as string,
        description: (body.description as string) ?? "",
        content: body.content as string,
      }, request.user!.id);
      return reply.code(201).send(skill);
    });

    server.delete<{ Params: { id: string } }>("/v1/skills/:id", async (request, reply) => {
      const rows = await db.select().from(schema.skills).where(eq(schema.skills.id, request.params.id));
      if (!rows.length || !canAccess(request.user!, rows[0].user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Skill not found"));
      }
      await skillService.delete(request.params.id);
      return { status: "deleted" };
    });

    // ─── Subagents ──────────────────────────────────────────
    server.get("/v1/agents", async (request) => {
      const user = request.user!;
      return subagentService.list(user.id);
    });

    server.post("/v1/agents", async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body.name || !body.prompt) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and prompt are required"));
      }
      const agent = await subagentService.create({
        name: body.name as string,
        description: (body.description as string) ?? "",
        prompt: body.prompt as string,
        tools: body.tools as string[] | undefined,
        model: body.model as string | undefined,
      }, request.user!.id);
      return reply.code(201).send(agent);
    });

    server.delete<{ Params: { id: string } }>("/v1/agents/:id", async (request, reply) => {
      const rows = await db.select().from(schema.subagents).where(eq(schema.subagents.id, request.params.id));
      if (!rows.length || !canAccess(request.user!, rows[0].user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Agent not found"));
      }
      await subagentService.delete(request.params.id);
      return { status: "deleted" };
    });

    // ─── Git Providers ──────────────────────────────────────
    server.get("/v1/git-providers", async (request) => {
      const user = request.user!;
      return gitProviderService.list(user.id);
    });

    server.post("/v1/git-providers", async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body.name || !body.type || !body.token) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, type, and token are required"));
      }
      const provider = await gitProviderService.create({
        name: body.name as string,
        type: body.type as "github" | "gitlab" | "bitbucket",
        token: body.token as string,
        user_name: body.user_name as string | undefined,
        user_email: body.user_email as string | undefined,
      }, request.user!.id);
      return reply.code(201).send(provider);
    });

    server.patch<{ Params: { id: string } }>("/v1/git-providers/:id", async (request, reply) => {
      const rows = await db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, request.params.id));
      if (!rows.length || !canAccess(request.user!, rows[0].user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Git provider not found"));
      }
      const updated = await gitProviderService.update(request.params.id, request.body as Record<string, unknown>);
      return updated;
    });

    server.delete<{ Params: { id: string } }>("/v1/git-providers/:id", async (request, reply) => {
      const rows = await db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, request.params.id));
      if (!rows.length || !canAccess(request.user!, rows[0].user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Git provider not found"));
      }
      await gitProviderService.delete(request.params.id);
      return { status: "deleted" };
    });
    // ─── Anthropic API Keys (user's own + admin-granted) ──
    server.get("/v1/anthropic-keys", async (request) => {
      const user = request.user!;
      return apiKeyService.list(user.id, user.role);
    });

    server.post<{
      Body: { name: string; provider: "api_key" | "subscription_token" | "ollama"; api_key?: string; auth_token?: string };
    }>("/v1/anthropic-keys", async (request, reply) => {
      const { name, provider, api_key, auth_token } = request.body;
      if (!name || !provider) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and provider are required"));
      }
      // Sanitize at the boundary. Keys are sent as HTTP header values
      // (Authorization / x-api-key) downstream — fetch rejects any byte
      // > 0xFF with "Cannot convert argument to a ByteString". Catching
      // it here gives the user a clean inline error instead of a cryptic
      // failure the first time we try to use the key. Smart quotes,
      // em-dashes, and zero-width spaces from copy-paste are the usual
      // culprits.
      const cleanApiKey = api_key?.trim();
      const cleanAuthToken = auth_token?.trim();
      const nonAscii = /[^\x20-\x7e]/;
      if (cleanApiKey && nonAscii.test(cleanApiKey)) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "API key contains a non-ASCII character — re-copy from the source (smart quotes or hidden characters break HTTP headers)."));
      }
      if (cleanAuthToken && nonAscii.test(cleanAuthToken)) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Auth token contains a non-ASCII character — re-copy from the source (smart quotes or hidden characters break HTTP headers)."));
      }
      const key = await apiKeyService.create({ name, provider, api_key: cleanApiKey, auth_token: cleanAuthToken }, request.user!.id);

      // Auto-create a default profile if user has none. Pass `provider`
      // through so an Ollama key produces an Ollama profile — without
      // this, the profile defaults to "api_key" and the orchestrator
      // would route to Anthropic with an Ollama credential.
      const userId = request.user!.id;
      const userProfiles = await profileService.list(userId);
      const ownProfiles = userProfiles.filter((p) => p.user_id === userId);
      if (ownProfiles.length === 0) {
        await profileService.create({ name: "default", provider, api_key_id: key.id }, userId);
      }

      return reply.code(201).send(key);
    });

    server.patch<{ Params: { id: string } }>("/v1/anthropic-keys/:id", async (request, reply) => {
      const key = await apiKeyService.get(request.params.id);
      if (!key || (key.user_id !== request.user!.id && request.user!.role !== "admin")) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
      }
      const updated = await apiKeyService.update(request.params.id, request.body as Record<string, unknown>);
      return updated;
    });

    server.delete<{ Params: { id: string } }>("/v1/anthropic-keys/:id", async (request, reply) => {
      const key = await apiKeyService.get(request.params.id);
      if (!key || (key.user_id !== request.user!.id && request.user!.role !== "admin")) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
      }
      const result = await apiKeyService.delete(request.params.id);
      if (result.error) return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, result.error));
      return { status: "deleted" };
    });

    // ─── API Tokens (per-user caller keys) ────────────────
    server.get("/v1/api-tokens", async (request) => {
      const user = request.user!;
      const rows = user.role === "admin"
        ? await db.select().from(schema.apiTokens)
        : await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.user_id, user.id));
      return rows.map((k) => ({
        id: k.id, name: k.name, allowed_profile_ids: k.allowed_profile_ids,
        rate_limit_rpm: k.rate_limit_rpm, created_at: k.created_at, last_used_at: k.last_used_at,
      }));
    });

    server.post<{
      Body: { name: string; allowed_profile_ids: string[]; rate_limit_rpm?: number };
    }>("/v1/api-tokens", async (request, reply) => {
      const { name, allowed_profile_ids, rate_limit_rpm } = request.body;
      if (!name) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name is required"));
      }
      // Empty allowed_profile_ids = access to all user's profiles
      const token = `rc_${randomBytes(24).toString("hex")}`;
      const hash = await bcrypt.hash(token, 10);
      const id = `key_${nanoid()}`;
      await db.insert(schema.apiTokens).values({
        id, name, key_hash: hash, user_id: request.user!.id,
        allowed_profile_ids: allowed_profile_ids ?? [], rate_limit_rpm: rate_limit_rpm ?? 60,
        created_at: new Date().toISOString(), last_used_at: null,
      });
      return reply.code(201).send({ id, name, caller_key: token, allowed_profile_ids });
    });

    server.patch<{
      Params: { id: string };
      Body: { name?: string; allowed_profile_ids?: string[]; rate_limit_rpm?: number };
    }>("/v1/api-tokens/:id", async (request, reply) => {
      const user = request.user!;
      const existing = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, request.params.id));
      if (!existing.length || (user.role !== "admin" && existing[0].user_id !== user.id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Token not found"));
      }
      const updates: Record<string, unknown> = {};
      if (request.body.name !== undefined) updates.name = request.body.name;
      if (request.body.allowed_profile_ids !== undefined) updates.allowed_profile_ids = request.body.allowed_profile_ids;
      if (request.body.rate_limit_rpm !== undefined) updates.rate_limit_rpm = request.body.rate_limit_rpm;
      if (Object.keys(updates).length > 0) {
        await db.update(schema.apiTokens).set(updates).where(eq(schema.apiTokens.id, request.params.id));
      }
      const updated = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, request.params.id));
      return { id: updated[0].id, name: updated[0].name, allowed_profile_ids: updated[0].allowed_profile_ids, rate_limit_rpm: updated[0].rate_limit_rpm };
    });

    server.delete<{ Params: { id: string } }>("/v1/api-tokens/:id", async (request, reply) => {
      const user = request.user!;
      const existing = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, request.params.id));
      if (!existing.length || (user.role !== "admin" && existing[0].user_id !== user.id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Token not found"));
      }
      await db.delete(schema.apiTokens).where(eq(schema.apiTokens.id, request.params.id));
      return { status: "deleted" };
    });

    // ── Secrets (vault) ──

    // Returns the first profile id in `profile_ids` that doesn't belong to
    // `userId`, or null if every id is owned. Used to reject cross-user
    // grants on secret create/update (feature #17).
    const firstUnownedProfileId = async (userId: string, profileIds: string[]): Promise<string | null> => {
      if (profileIds.length === 0) return null;
      const userProfiles = await profileService.list(userId);
      const ownIds = new Set(userProfiles.map((p) => p.id));
      return profileIds.find((pid) => !ownIds.has(pid)) ?? null;
    };

    server.get("/v1/secrets", {
      schema: {
        summary: "List secrets",
        description:
          "Returns the user's vault entries. **Values are always redacted** to `••••••••` — " +
          "they're never returned in plaintext over the API. The agent decrypts them in the " +
          "container at runtime. Each item is a `Secret`.",
        tags: ["Secrets"],
      },
    }, async (request) => {
      const userId = request.user!.id;
      const secrets = await secretVaultService.list(userId);
      if (!opts.hiddenUserSecretIdsForOrg) return secrets;
      const activeOrgId = request.orgContext?.org_id ?? null;
      const hidden = await opts.hiddenUserSecretIdsForOrg(userId, activeOrgId);
      if (hidden.size === 0) return secrets;
      return secrets.filter((s) => !hidden.has(s.id));
    });

    server.post<{ Body: { name: string; value: string; scope?: "all" | "agents"; profile_ids?: string[] } }>(
      "/v1/secrets",
      {
        schema: {
          summary: "Create a secret",
          description:
            "Stores an encrypted secret (AES-256-GCM) in the user's vault. `name` becomes the env-var " +
            "name in agent containers — must match `^[A-Z_][A-Z0-9_]*$`. Scope determines which agents " +
            "see it: `all` (default) injects into every container the user runs; `agents` restricts to " +
            "the listed `profile_ids` (must all belong to the user).",
          tags: ["Secrets"],
          body: { $ref: "CreateSecretInput#" },
        },
      },
      async (request, reply) => {
        try {
          const { name, value, scope, profile_ids } = request.body;
          if (!name || !value) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Name and value are required"));
          }
          if (profile_ids && profile_ids.length > 0) {
            const bad = await firstUnownedProfileId(request.user!.id, profile_ids);
            if (bad) {
              return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `Profile not found: ${bad}`));
            }
          }
          const secret = await secretVaultService.create(request.user!.id, name, value, { scope, profile_ids });
          return reply.code(201).send(secret);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to create secret";
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, message));
        }
      },
    );

    server.patch<{ Params: { id: string }; Body: { name?: string; value?: string; scope?: "all" | "agents"; profile_ids?: string[] } }>(
      "/v1/secrets/:id",
      {
        schema: {
          summary: "Update a secret",
          description:
            "Patches `name`, `value`, `scope`, or `profile_ids`. Omitted fields are untouched. To clear " +
            "a per-agent grant entirely, set `scope: 'all'` (clears `profile_ids` automatically) or set " +
            "`profile_ids` to a new non-empty list.",
          tags: ["Secrets"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", example: "sec_xQ8...e0" } },
          },
          body: { $ref: "UpdateSecretInput#" },
        },
      },
      async (request, reply) => {
        try {
          const { profile_ids } = request.body;
          if (profile_ids && profile_ids.length > 0) {
            const bad = await firstUnownedProfileId(request.user!.id, profile_ids);
            if (bad) {
              return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `Profile not found: ${bad}`));
            }
          }
          const updated = await secretVaultService.update(
            request.params.id,
            request.user!.id,
            request.body,
          );
          if (!updated) {
            return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Secret not found"));
          }
          return updated;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to update secret";
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, message));
        }
      },
    );

    server.delete<{ Params: { id: string } }>(
      "/v1/secrets/:id",
      {
        schema: {
          summary: "Delete a secret",
          description: "Removes the secret. Returns `{ status: 'deleted', secret_id }`.",
          tags: ["Secrets"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      async (request, reply) => {
        const deleted = await secretVaultService.delete(request.params.id, request.user!.id);
        if (!deleted) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Secret not found"));
        }
        return { status: "deleted", secret_id: request.params.id };
      },
    );
  },
  { name: "user-resource-routes" },
);

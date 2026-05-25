import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { ErrorCodes, errorResponse, ValidationError } from "../errors.js";
import { ProfileService } from "../services/profile-service.js";
import { ApiKeyService } from "../services/api-key-service.js";
import { ToolFileService } from "../services/tool-file-service.js";
import { SkillService } from "../services/skill-service.js";
import { SubagentService } from "../services/subagent-service.js";
import { GitProviderService } from "../services/git-provider-service.js";
import type { ContainerManager, TokenValidator } from "@vonzio/shared";
import { validateAnthropicKey } from "../services/key-validator.js";
import { createProfileSchema, updateProfileSchema, sendValidationError } from "./validation.js";
import type { Auth } from "../auth/better-auth.js";
import { userAuthHook, adminOnlyHook } from "../auth/user-auth.js";

export interface AdminRoutesOptions {
  auth: Auth;
  db: DrizzleDB;
  tokenValidator: TokenValidator;
  profileService: ProfileService;
  apiKeyService: ApiKeyService;
  toolFileService: ToolFileService;
  skillService: SkillService;
  subagentService: SubagentService;
  gitProviderService: GitProviderService;
  containerManager: ContainerManager;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (server, opts) => {
    const { auth, db, tokenValidator, profileService, apiKeyService, toolFileService, skillService, subagentService, gitProviderService, containerManager } = opts;

    // Auth + admin-only hooks scoped to this plugin
    server.addHook("onRequest", userAuthHook(auth, tokenValidator));
    server.addHook("onRequest", adminOnlyHook);

    // --- Bootstrap: create caller key + profile in one step ---
    server.post<{
      Body: {
        name?: string;
        api_key?: string;
        auth_token?: string;
        provider?: "api_key" | "subscription_token";
      };
    }>("/admin/bootstrap", async (request, reply) => {
      const name = request.body?.name || "default";
      const apiKey = request.body?.api_key;
      const authToken = request.body?.auth_token;
      const provider = request.body?.provider || "api_key";

      if (!apiKey && !authToken) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "api_key or auth_token is required"));
      }

      // Create API key first, then profile referencing it
      const anthropicKey = await apiKeyService.create({
        name: name + " Key",
        provider,
        api_key: apiKey,
        auth_token: authToken,
      });

      const profile = await profileService.create({
        name,
        api_key_id: anthropicKey.id,
      });

      // Create caller key with access to this profile
      const token = `rc_${randomBytes(24).toString("hex")}`;
      const hash = await bcrypt.hash(token, 10);
      const keyId = `key_${nanoid()}`;

      await db.insert(schema.apiTokens)
        .values({
          id: keyId,
          name,
          key_hash: hash,
          user_id: request.user?.id,
          allowed_profile_ids: [profile.id],
          rate_limit_rpm: 60,
          created_at: new Date().toISOString(),
          last_used_at: null,
        });

      return reply.code(201).send({
        caller_key: token,
        caller_key_id: keyId,
        profile_id: profile.id,
        profile_name: profile.name,
      });
    });

    // --- API token management ---
    server.get("/admin/keys", async () => {
      const keys = await db.select().from(schema.apiTokens);
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        allowed_profile_ids: k.allowed_profile_ids,
        rate_limit_rpm: k.rate_limit_rpm,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
      }));
    });

    server.post<{
      Body: {
        name: string;
        allowed_profile_ids: string[];
        rate_limit_rpm?: number;
      };
    }>("/admin/keys", async (request, reply) => {
      const { name, allowed_profile_ids, rate_limit_rpm } = request.body;

      if (!name || !allowed_profile_ids?.length) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and allowed_profile_ids are required"));
      }

      const token = `rc_${randomBytes(24).toString("hex")}`;
      const hash = await bcrypt.hash(token, 10);
      const id = `key_${nanoid()}`;

      await db.insert(schema.apiTokens)
        .values({
          id,
          name,
          key_hash: hash,
          user_id: request.user?.id,
          allowed_profile_ids,
          rate_limit_rpm: rate_limit_rpm ?? 60,
          created_at: new Date().toISOString(),
          last_used_at: null,
        });

      return reply.code(201).send({
        id,
        name,
        caller_key: token,
        allowed_profile_ids,
      });
    });

    server.patch<{
      Params: { id: string };
      Body: Partial<{ name: string; allowed_profile_ids: string[]; rate_limit_rpm: number }>;
    }>("/admin/keys/:id", async (request, reply) => {
      const { name, allowed_profile_ids, rate_limit_rpm } = request.body;
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (allowed_profile_ids !== undefined) updates.allowed_profile_ids = allowed_profile_ids;
      if (rate_limit_rpm !== undefined) updates.rate_limit_rpm = rate_limit_rpm;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "No fields to update"));
      }

      const result = await db
        .update(schema.apiTokens)
        .set(updates)
        .where(eq(schema.apiTokens.id, request.params.id));

      if (result.rowCount === 0) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Key not found"));
      }

      const updated = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, request.params.id));
      return {
        id: updated[0].id,
        name: updated[0].name,
        allowed_profile_ids: updated[0].allowed_profile_ids,
        rate_limit_rpm: updated[0].rate_limit_rpm,
        created_at: updated[0].created_at,
        last_used_at: updated[0].last_used_at,
      };
    });

    server.delete<{ Params: { id: string } }>("/admin/keys/:id", async (request, reply) => {
      const result = await db
        .delete(schema.apiTokens)
        .where(eq(schema.apiTokens.id, request.params.id));

      if (result.rowCount === 0) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Key not found"));
      }
      return { status: "deleted", key_id: request.params.id };
    });

    // --- Anthropic API Key management (admin only) ---
    server.get<{ Querystring: { user_id?: string } }>("/admin/api-keys", async (request) => {
      return apiKeyService.list(request.query.user_id);
    });

    server.post<{
      Body: { name: string; provider: "api_key" | "subscription_token"; api_key?: string; auth_token?: string; allowed_user_ids?: string[] };
    }>("/admin/api-keys", async (request, reply) => {
      const { name, provider, api_key, auth_token, allowed_user_ids } = request.body;
      if (!name || !provider) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name and provider are required"));
      }
      const isShared = (request.body as Record<string, unknown>).shared === true;
      const key = await apiKeyService.create({ name, provider, api_key, auth_token, allowed_user_ids }, isShared ? undefined : request.user!.id);

      // Validate key if provided
      const rawKey = api_key ?? auth_token;
      let validation: { valid: boolean; error?: string } | undefined;
      if (rawKey) {
        validation = await validateAnthropicKey(rawKey, provider).catch(() => undefined);
      }

      return reply.code(201).send({ ...key, validation });
    });

    server.patch<{
      Params: { id: string };
      Body: { name?: string; provider?: "api_key" | "subscription_token"; api_key?: string; auth_token?: string; allowed_user_ids?: string[] };
    }>("/admin/api-keys/:id", async (request, reply) => {
      const updated = await apiKeyService.update(request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
      }
      return updated;
    });

    server.delete<{ Params: { id: string } }>("/admin/api-keys/:id", async (request, reply) => {
      const result = await apiKeyService.delete(request.params.id);
      if (result.error) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, result.error));
      }
      if (!result.deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
      }
      return { status: "deleted", api_key_id: request.params.id };
    });

    server.post<{ Params: { id: string } }>("/admin/api-keys/:id/validate", async (request, reply) => {
      const key = await apiKeyService.getWithSecrets(request.params.id);
      if (!key) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
      }
      const rawKey = key.api_key ?? key.auth_token;
      if (!rawKey) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "API key has no credential stored"));
      }
      const result = await validateAnthropicKey(rawKey, key.provider);
      return result;
    });

    // --- Profile management (via admin) ---
    server.get("/admin/profiles", async () => {
      return profileService.list();
    });

    server.post("/admin/profiles", async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      try {
        const profile = await profileService.create(body as any);
        return reply.code(201).send(profile);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err.message));
        }
        throw err;
      }
    });

    server.patch<{ Params: { id: string } }>("/admin/profiles/:id", async (request, reply) => {
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      try {
        const profile = await profileService.update(request.params.id, parsed.data, "admin");
        if (!profile) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
        }
        return profile;
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err.message));
        }
        throw err;
      }
    });

    server.delete<{ Params: { id: string } }>("/admin/profiles/:id", async (request, reply) => {
      const result = await profileService.delete(request.params.id);
      if (result.error) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, result.error));
      }
      if (!result.deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      }
      return { status: "deleted", profile_id: request.params.id };
    });

    // --- Tool file management ---
    server.get("/admin/tools", async () => {
      return toolFileService.list();
    });

    server.get<{ Params: { id: string } }>("/admin/tools/:id/code", async (request, reply) => {
      const code = await toolFileService.getCode(request.params.id);
      if (code === null) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Tool not found"));
      }
      return { id: request.params.id, code };
    });

    server.post<{
      Body: {
        name: string;
        description?: string;
        file_name: string;
        code: string;
        input_schema?: string;
      };
    }>("/admin/tools", async (request, reply) => {
      const { name, description, file_name, code, input_schema } = request.body;
      if (!name || !file_name || !code) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, file_name, and code are required"));
      }
      const tool = await toolFileService.upload({ name, description, file_name, code, input_schema });
      return reply.code(201).send(tool);
    });

    server.delete<{ Params: { id: string } }>("/admin/tools/:id", async (request, reply) => {
      const deleted = await toolFileService.delete(request.params.id);
      if (!deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Tool not found or is a filesystem tool"));
      }
      return { status: "deleted", tool_id: request.params.id };
    });

    // --- Skill management ---
    server.get("/admin/skills", async () => {
      return skillService.list();
    });

    server.post<{
      Body: { name: string; description: string; content: string };
    }>("/admin/skills", async (request, reply) => {
      const { name, description, content } = request.body;
      if (!name || !description || !content) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, description, and content are required"));
      }
      const skill = await skillService.upload({ name, description, content });
      return reply.code(201).send(skill);
    });

    server.delete<{ Params: { id: string } }>("/admin/skills/:id", async (request, reply) => {
      const deleted = await skillService.delete(request.params.id);
      if (!deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Skill not found or is a filesystem skill"));
      }
      return { status: "deleted", skill_id: request.params.id };
    });

    // --- Subagent management ---
    server.get("/admin/agents", async () => {
      return subagentService.list();
    });

    server.post<{
      Body: { name: string; description: string; prompt: string; tools?: string[]; model?: string };
    }>("/admin/agents", async (request, reply) => {
      const { name, description, prompt, tools, model } = request.body;
      if (!name || !description || !prompt) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, description, and prompt are required"));
      }
      const agent = await subagentService.create({ name, description, prompt, tools, model });
      return reply.code(201).send(agent);
    });

    server.delete<{ Params: { id: string } }>("/admin/agents/:id", async (request, reply) => {
      const deleted = await subagentService.delete(request.params.id);
      if (!deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Agent not found"));
      }
      return { status: "deleted", agent_id: request.params.id };
    });

    // --- Git providers ---
    server.get("/admin/git-providers", async () => {
      return gitProviderService.list();
    });

    server.post<{
      Body: { name: string; type: "github" | "gitlab" | "bitbucket"; token: string; user_name?: string; user_email?: string };
    }>("/admin/git-providers", async (request, reply) => {
      const { name, type, token, user_name, user_email } = request.body;
      if (!name || !type || !token) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, type, and token are required"));
      }
      const provider = await gitProviderService.create({ name, type, token, user_name, user_email });
      return reply.code(201).send(provider);
    });

    server.patch<{
      Params: { id: string };
      Body: Partial<{ name: string; type: "github" | "gitlab" | "bitbucket"; token: string; user_name: string; user_email: string }>;
    }>("/admin/git-providers/:id", async (request, reply) => {
      const updated = await gitProviderService.update(request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Git provider not found"));
      }
      return updated;
    });

    server.delete<{ Params: { id: string } }>("/admin/git-providers/:id", async (request, reply) => {
      const deleted = await gitProviderService.delete(request.params.id);
      if (!deleted) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Git provider not found"));
      }
      return { status: "deleted", provider_id: request.params.id };
    });

    // --- Profile API key validation (via linked api_key) ---
    server.post<{ Params: { id: string } }>("/admin/profiles/:id/validate", async (request, reply) => {
      const resolved = await profileService.getResolved(request.params.id);
      if (!resolved) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      }

      const key = resolved.resolved_api_key ?? resolved.resolved_auth_token;
      if (!key) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Profile has no linked API key"));
      }

      const result = await validateAnthropicKey(key, resolved.resolved_provider);
      return { profile_id: resolved.id, ...result };
    });

    // --- Docker images ---
    server.get<{ Querystring: { filter?: string } }>("/admin/images", async (request) => {
      return containerManager.listImages(request.query.filter ?? "vonzio");
    });

    // Invite management lives in @vonzio/cp-server (multi-tenant only).
    // OSS deployments don't expose /admin/invites at all.

    // Feature flags (Ollama access, etc.)
    server.patch<{ Params: { userId: string }; Body: { feature_flags: string } }>("/admin/users/:userId/flags", async (request, reply) => {
      const { userId } = request.params;
      const { feature_flags } = request.body;
      if (typeof feature_flags !== "string") {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "feature_flags must be a string"));
      }
      await db.execute(sql`UPDATE "user" SET "feature_flags" = ${feature_flags} WHERE id = ${userId}`);
      return { status: "updated", feature_flags };
    });
};

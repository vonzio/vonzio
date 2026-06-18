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
import type { FastifyRequest } from "fastify";
import { authorizeTenantAccess } from "../auth/user-auth.js";

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
import { DocumentService, DocumentError } from "../services/document-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import type { ProfileProvider } from "@vonzio/shared";

export interface UserResourceRoutesOptions {
  db: DrizzleDB;
  apiKeyService: ApiKeyService;
  profileService: ProfileService;
  toolFileService: ToolFileService;
  skillService: SkillService;
  subagentService: SubagentService;
  gitProviderService: GitProviderService;
  secretVaultService: SecretVaultService;
  documentService: DocumentService;
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
    const { db, apiKeyService, profileService, toolFileService, skillService, subagentService, gitProviderService, secretVaultService, documentService } = opts;

    // Profile ownership gate for per-agent sub-resources (documents). Returns
    // the profile if the caller may manage it, else null.
    const ownedProfile = async (profileId: string, user: { id: string; role: string }) => {
      const profile = await profileService.get(profileId);
      if (!profile) return null;
      return canAccess(user, profile.user_id) ? profile : null;
    };

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

    // ─── Documents (per-agent knowledge) ────────────────────
    // Mounted read-only into every container the profile spawns at /knowledge;
    // the agent reads them on the fly with Read/Grep/Glob.
    server.get<{ Params: { id: string } }>("/v1/profiles/:id/documents", async (request, reply) => {
      const profile = await ownedProfile(request.params.id, request.user!);
      if (!profile) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      return documentService.list(request.params.id);
    });

    server.post<{
      Params: { id: string };
      Body: { name: string; media_type: string; content_b64: string };
      // Allow large base64 bodies (Fastify's default is 1 MB). Derive the
      // limit from the configured per-file cap: base64 inflates ~1.34×, plus
      // JSON/field overhead → 1.5× + 4 MB headroom. The real per-file /
      // per-profile caps enforce on decoded bytes in DocumentService.upload.
    }>("/v1/profiles/:id/documents", { bodyLimit: Math.ceil(documentService.maxDocumentBytes * 1.5) + 4 * 1024 * 1024 }, async (request, reply) => {
      const profile = await ownedProfile(request.params.id, request.user!);
      if (!profile) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      const { name, media_type, content_b64 } = request.body ?? {};
      if (!name || !media_type || !content_b64) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, media_type and content_b64 are required"));
      }
      try {
        const doc = await documentService.upload(
          { profile_id: request.params.id, name, media_type, content_b64 },
          request.user!.id,
        );
        return reply.code(201).send(doc);
      } catch (err) {
        if (err instanceof DocumentError) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, err.message));
        }
        throw err;
      }
    });

    server.delete<{ Params: { id: string; docId: string } }>("/v1/profiles/:id/documents/:docId", async (request, reply) => {
      const profile = await ownedProfile(request.params.id, request.user!);
      if (!profile) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      // Must be an AGENT-level doc (session_id null) belonging to THIS profile.
      const owner = await documentService.getOwner(request.params.docId);
      if (!owner || owner.profile_id !== request.params.id || owner.session_id !== null) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Document not found"));
      }
      await documentService.delete(request.params.docId);
      return { status: "deleted" };
    });

    // Fetch + stream a verified document's bytes inline (shared by both scopes).
    const serveRawDocument = async (reply: import("fastify").FastifyReply, docId: string) => {
      const doc = await documentService.getContent(docId);
      if (!doc) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Document not found"));
      return reply
        .header("Content-Type", doc.media_type || "application/octet-stream")
        .header("Content-Disposition", `inline; filename="${doc.name.replace(/["\\]/g, "")}"`)
        .send(doc.bytes);
    };

    // Raw bytes for the in-dashboard viewer (PDF/image). Inline disposition.
    server.get<{ Params: { id: string; docId: string } }>("/v1/profiles/:id/documents/:docId/raw", async (request, reply) => {
      const profile = await ownedProfile(request.params.id, request.user!);
      if (!profile) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
      const owner = await documentService.getOwner(request.params.docId);
      if (!owner || owner.profile_id !== request.params.id || owner.session_id !== null) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Document not found"));
      }
      return serveRawDocument(reply, request.params.docId);
    });

    // ─── Documents (per-workspace knowledge) ────────────────
    // Scoped to a single workspace (session). Mounted at /knowledge alongside
    // the agent-level docs, but only for that conversation.
    const ownedWorkspace = async (sessionId: string, request: FastifyRequest) => {
      const rows = await db.select({ user_id: schema.workspaces.user_id, profile_id: schema.workspaces.profile_id, org_id: schema.workspaces.org_id })
        .from(schema.workspaces).where(eq(schema.workspaces.session_id, sessionId));
      const ws = rows[0];
      if (!ws) return null;
      // Tenant boundary: SaaS requires org-match (no role bypass), OSS
      // owner-or-admin. Previously user_id-only, letting a user reach a
      // workspace's docs from another org's context.
      return authorizeTenantAccess(request, ws) ? ws : null;
    };

    server.get<{ Params: { id: string } }>("/v1/workspaces/:id/documents", async (request, reply) => {
      const ws = await ownedWorkspace(request.params.id, request);
      if (!ws) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      return documentService.listForSession(request.params.id);
    });

    server.post<{
      Params: { id: string };
      Body: { name: string; media_type: string; content_b64: string };
    }>("/v1/workspaces/:id/documents", { bodyLimit: Math.ceil(documentService.maxDocumentBytes * 1.5) + 4 * 1024 * 1024 }, async (request, reply) => {
      const ws = await ownedWorkspace(request.params.id, request);
      if (!ws) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      const { name, media_type, content_b64 } = request.body ?? {};
      if (!name || !media_type || !content_b64) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "name, media_type and content_b64 are required"));
      }
      try {
        const doc = await documentService.upload(
          { profile_id: ws.profile_id, session_id: request.params.id, name, media_type, content_b64 },
          request.user!.id,
        );
        return reply.code(201).send(doc);
      } catch (err) {
        if (err instanceof DocumentError) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, err.message));
        }
        throw err;
      }
    });

    server.delete<{ Params: { id: string; docId: string } }>("/v1/workspaces/:id/documents/:docId", async (request, reply) => {
      const ws = await ownedWorkspace(request.params.id, request);
      if (!ws) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      const owner = await documentService.getOwner(request.params.docId);
      if (!owner || owner.session_id !== request.params.id) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Document not found"));
      }
      await documentService.delete(request.params.docId);
      return { status: "deleted" };
    });

    server.get<{ Params: { id: string; docId: string } }>("/v1/workspaces/:id/documents/:docId/raw", async (request, reply) => {
      const ws = await ownedWorkspace(request.params.id, request);
      if (!ws) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      const owner = await documentService.getOwner(request.params.docId);
      if (!owner || owner.session_id !== request.params.id) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Document not found"));
      }
      return serveRawDocument(reply, request.params.docId);
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
      Body: { name: string; provider: ProfileProvider; api_key?: string; base_url?: string };
    }>("/v1/anthropic-keys", async (request, reply) => {
      const { name, provider, api_key, base_url } = request.body;
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
      const nonAscii = /[^\x20-\x7e]/;
      if (cleanApiKey && nonAscii.test(cleanApiKey)) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "API key contains a non-ASCII character — re-copy from the source (smart quotes or hidden characters break HTTP headers)."));
      }
      const key = await apiKeyService.create(
        { name, provider, api_key: cleanApiKey, base_url: provider === "openai" ? base_url?.trim() || null : null },
        request.user!.id,
      );

      // Auto-create a default profile if user has none. Pass `provider`
      // through so an Ollama key produces an Ollama profile — without
      // this, the profile defaults to "api_key" and the orchestrator
      // would route to Anthropic with an Ollama credential.
      const userId = request.user!.id;
      const userProfiles = await profileService.list(userId);
      const ownProfiles = userProfiles.filter((p) => p.user_id === userId);
      if (ownProfiles.length === 0) {
        await profileService.create({ name: "default", provider, api_key_id: key.id }, userId);
      } else if (ownProfiles.every((p) => !p.api_key_id)) {
        // The user has profiles but NONE has a key (e.g. they deleted all keys,
        // or skipped onboarding into a keyless default). Attach this first key
        // to their default/first profile so chatting works immediately — without
        // this the key is created but orphaned and the workspace stays gated.
        const target = ownProfiles.find((p) => p.name === "default") ?? ownProfiles[0];
        // Set provider too — a keyless default is "api_key" by default, which
        // would mis-route an Ollama/OpenAI key to Anthropic.
        await profileService.update(target.id, { api_key_id: key.id, provider }, request.user!.role);
      }

      return reply.code(201).send(key);
    });

    // Validate a credential WITHOUT saving — powers the "Test connection"
    // button in the add/edit dialog. Accepts raw entered values (add form, or
    // a freshly-typed key in the edit form) and/or an existing key id (edit
    // form with the key left masked). The form's base_url always wins so a
    // changed endpoint is tested even when the key itself is unchanged.
    server.post<{
      Body: { provider?: ProfileProvider; api_key?: string; base_url?: string | null; id?: string };
    }>("/v1/anthropic-keys/validate", async (request, reply) => {
      const { validateAnthropicKey } = await import("../services/key-validator.js");
      const { provider, api_key, base_url, id } = request.body;

      let keyToTest = api_key && api_key.trim() && api_key !== "••••••••" ? api_key.trim() : undefined;
      let providerToTest = provider;
      let baseToTest = base_url;

      // Fall back to the stored secret when the key field is masked/blank.
      if (!keyToTest && id) {
        // Same visibility as the by-key model routes (own + admin + shared/org).
        if (!(await apiKeyService.isAccessible(id, request.user!.id, request.user!.role))) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "API key not found"));
        }
        const stored = await apiKeyService.getWithSecrets(id);
        if (!stored?.api_key) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "This key has no stored credential to test"));
        }
        keyToTest = stored.api_key;
        providerToTest = providerToTest ?? stored.provider;
        if (baseToTest === undefined) baseToTest = stored.base_url;
      }

      if (!keyToTest) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Enter a key to test"));
      }
      const nonAscii = /[^\x20-\x7e]/;
      if (nonAscii.test(keyToTest)) {
        return { valid: false, error: "Key contains a non-ASCII character — re-copy from the source." };
      }
      return validateAnthropicKey(keyToTest, providerToTest ?? "api_key", baseToTest);
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

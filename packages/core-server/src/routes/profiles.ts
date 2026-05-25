import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ProfileService } from "../services/profile-service.js";
import type { ApiKeyService } from "../services/api-key-service.js";
import type { ModelListService } from "../services/model-list-service.js";
import { ErrorCodes, errorResponse, ValidationError } from "../errors.js";
import { isOwnerOrAdmin } from "../auth/user-auth.js";
import { createProfileSchema, updateProfileSchema, sendValidationError } from "./validation.js";

export interface ProfileRoutesOptions {
  profileService: ProfileService;
  apiKeyService: ApiKeyService;
  modelListService: ModelListService;
}

export const profileRoutes = fp(
  async (server: FastifyInstance, opts: ProfileRoutesOptions) => {
    const { profileService, apiKeyService, modelListService } = opts;

    server.post("/v1/profiles", {
      schema: {
        summary: "Create a profile",
        description:
          "Creates a new agent profile owned by the authenticated user. `slug` is " +
          "auto-derived from `name` if omitted and collision-resolved against the " +
          "user's existing profiles. Returns the full `Profile` (see schemas).",
        tags: ["Profiles"],
        // No strict body schema — Zod handles validation at the route level
        // (createProfileSchema). Documentation-only ref:
        body: { $ref: "CreateProfileInput#" },
      },
    }, async (request, reply) => {
      const parsed = createProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      try {
        const profile = await profileService.create(parsed.data, request.user!.id, request.user!.role);
        return reply.code(201).send(profile);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err.message));
        }
        throw err;
      }
    });

    server.get("/v1/profiles", {
      schema: {
        summary: "List profiles",
        description:
          "Returns the authenticated user's profiles plus any shared/system " +
          "profiles visible to everyone. Each item is a `Profile`.",
        tags: ["Profiles"],
      },
    }, async (request) => {
      const user = request.user!;
      return profileService.list(user.id);
    });

    server.get<{ Params: { id: string } }>(
      "/v1/profiles/:id",
      {
        schema: {
          summary: "Get a profile",
          description: "Returns a single `Profile`. 404 if the id is unknown or the user can't access it.",
          tags: ["Profiles"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", example: "prof_4XgS61A_vp7lfWXopdIMV" } },
          },
        },
      },
      async (request, reply) => {
        const profile = await profileService.get(request.params.id);
        if (!profile || !isOwnerOrAdmin(request.user!, profile.user_id ?? null)) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
        }
        return profile;
      },
    );

    server.patch<{ Params: { id: string } }>(
      "/v1/profiles/:id",
      {
        schema: {
          summary: "Update a profile",
          description:
            "Patches the profile. Only provided fields are touched. Returns the updated `Profile`. " +
            "Useful endpoints to call here: `claude_md` (sync the agent's system prompt from a repo), " +
            "`model` (switch family), `memory_enabled`, `default_tools`.",
          tags: ["Profiles"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          body: { $ref: "UpdateProfileInput#" },
        },
      },
      async (request, reply) => {
        const parsed = updateProfileSchema.safeParse(request.body);
        if (!parsed.success) {
          return sendValidationError(reply, parsed.error);
        }
        const profile = await profileService.get(request.params.id);
        if (!profile || !isOwnerOrAdmin(request.user!, profile.user_id ?? null)) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
        }
        try {
          const updated = await profileService.update(request.params.id, parsed.data, request.user!.role);
          if (!updated) {
            return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
          }
          return updated;
        } catch (err) {
          if (err instanceof ValidationError) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err.message));
          }
          throw err;
        }
      },
    );

    server.delete<{ Params: { id: string } }>(
      "/v1/profiles/:id",
      {
        schema: {
          summary: "Delete a profile",
          description:
            "Soft-blocks if the profile has live dependencies (workspaces, playbooks). Returns " +
            "`{ status: 'deleted', profile_id }` on success.",
          tags: ["Profiles"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      async (request, reply) => {
        const profile = await profileService.get(request.params.id);
        if (!profile || !isOwnerOrAdmin(request.user!, profile.user_id ?? null)) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
        }
        const result = await profileService.delete(request.params.id);
        if (result.error) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, result.error));
        }
        return { status: "deleted", profile_id: request.params.id };
      },
    );

    // Models available for a profile (per-workspace model override picker).
    // Delegates to ModelListService which is shared with the Telegram and
    // Slack chat surfaces so the picker behavior is identical everywhere.
    server.get<{ Params: { id: string } }>(
      "/v1/profiles/:id/models",
      {
        schema: {
          summary: "List models available to this profile",
          description:
            "Returns the model list the profile's API key has access to. Anthropic profiles return " +
            "`claude-*` IDs; Ollama profiles return their installed-locally set. Cached server-side " +
            "by `api_key_id` (5-minute TTL), so repeated calls don't hammer the provider.",
          tags: ["Profiles"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      async (request, reply) => {
        const profile = await profileService.get(request.params.id);
        if (!profile || !isOwnerOrAdmin(request.user!, profile.user_id ?? null)) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Profile not found"));
        }
        const result = await modelListService.listForProfile(profile.id);
        if (!result.ok) {
          return reply.code(result.status).send(errorResponse(
            result.status === 404 ? ErrorCodes.NOT_FOUND : ErrorCodes.BAD_REQUEST,
            result.error,
          ));
        }
        return { models: result.models };
      },
    );
  },
  { name: "profile-routes" },
);

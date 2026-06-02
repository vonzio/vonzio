import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ProfileService } from "../services/profile-service.js";
import type { ApiKeyService } from "../services/api-key-service.js";
import type { ModelListService } from "../services/model-list-service.js";
import { ErrorCodes, errorResponse, ValidationError } from "../errors.js";
import { isOwnerOrAdmin } from "../auth/user-auth.js";
import { createProfileSchema, updateProfileSchema, sendValidationError } from "./validation.js";
import { getActiveOrgId } from "../lib/active-org.js";

export interface ProfileRoutesOptions {
  profileService: ProfileService;
  apiKeyService: ApiKeyService;
  modelListService: ModelListService;
  /** SaaS-only — fires on POST to tag the new profile with the active
   *  org. OSS leaves this undefined; profiles get no affinity. */
  recordProfileOrg?: (profileId: string, orgId: string) => Promise<void>;
  /** SaaS-only — fires on DELETE to drop the side-table row. */
  forgetProfileOrg?: (profileId: string) => Promise<void>;
  /** SaaS-only — filters the GET response by active org affinity.
   *  Returns null → no filter (OSS / no active-org context). */
  visibleProfileIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
    candidateProfileIds: string[],
  ) => Promise<Set<string> | null>;
  /** SaaS-only — returns true when the profile is a materialized
   *  org_profile (team-shared agent). PATCH/DELETE reject with 403
   *  when true; the row is read-only to members. */
  isMaterializedOrgProfile?: (profileId: string) => Promise<boolean>;
  /** SaaS-only — batch variant: which of these profile_ids are
   *  materialized org_profiles. The GET handler uses this to tag
   *  each row's `team_owned` field. */
  materializedOrgProfileIds?: (profileIds: string[]) => Promise<Set<string>>;
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
        // Tag with the active org so the row is only visible in that
        // tenant scope. OSS deployments (hook undefined) and admin
        // shared-profile creates (no active-org context) skip the call.
        const activeOrgId = getActiveOrgId();
        if (opts.recordProfileOrg && activeOrgId) {
          await opts.recordProfileOrg(profile.id, activeOrgId);
        }
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
      let profiles = await profileService.list(user.id);
      // Tenant filter: cp-server returns the set of profile ids that
      // belong to the active org (plus un-tagged legacy rows). Hook
      // returning null = "no filter applies" (OSS / no active-org).
      if (opts.visibleProfileIdsForOrg) {
        const activeOrgId = getActiveOrgId();
        const visible = await opts.visibleProfileIdsForOrg(
          user.id,
          activeOrgId,
          profiles.map((p) => p.id),
        );
        if (visible) profiles = profiles.filter((p) => visible.has(p.id));
      }
      // Tag team-owned rows so the dashboard can segment "Your
      // agents" / "Team agents" and skip offering edit/delete on
      // materialized rows.
      if (opts.materializedOrgProfileIds && profiles.length > 0) {
        const teamOwned = await opts.materializedOrgProfileIds(profiles.map((p) => p.id));
        if (teamOwned.size > 0) {
          profiles = profiles.map((p) =>
            teamOwned.has(p.id) ? { ...p, team_owned: true } : p,
          );
        }
      }
      return profiles;
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
        // Team-shared agents are owner-managed. The materialized row
        // shows up under each member's user_id so the existing scope
        // check (above) passes, but writes need to go through
        // /api/orgs/:slug/profiles/:id, not here.
        if (opts.isMaterializedOrgProfile && await opts.isMaterializedOrgProfile(request.params.id)) {
          return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "This is a team agent — only the org owner can edit it"));
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
        // Same gate as PATCH — team agents go through the org route.
        if (opts.isMaterializedOrgProfile && await opts.isMaterializedOrgProfile(request.params.id)) {
          return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "This is a team agent — only the org owner can delete it"));
        }
        const result = await profileService.delete(request.params.id);
        if (result.error) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, result.error));
        }
        if (opts.forgetProfileOrg) {
          await opts.forgetProfileOrg(request.params.id);
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

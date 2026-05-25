import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { IntegrationService } from "../services/integration-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { NotificationChannel } from "@vonzio/shared";
import type { Scope } from "../services/scope.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface IntegrationRoutesOptions {
  integrationService: IntegrationService;
  notificationService: NotificationService;
  profileService: ProfileService;
}

export const integrationRoutes = fp(
  async (server: FastifyInstance, opts: IntegrationRoutesOptions) => {
    const { integrationService, notificationService, profileService } = opts;

    // Returns the first profile id in `profile_ids` that doesn't belong to
    // `userId`, or null if every id is owned. Used to reject cross-user
    // grants on integration scope updates — mirrors the equivalent helper
    // for /v1/secrets.
    const firstUnownedProfileId = async (userId: string, profileIds: string[]): Promise<string | null> => {
      if (profileIds.length === 0) return null;
      const userProfiles = await profileService.list(userId);
      const ownIds = new Set(userProfiles.map((p) => p.id));
      return profileIds.find((pid) => !ownIds.has(pid)) ?? null;
    };

    server.get("/v1/integrations", async (request) => {
      const user = request.user!;
      return integrationService.list(user.id);
    });

    server.post<{
      Body: { type: string; config: Record<string, unknown>; is_default?: boolean };
    }>("/v1/integrations", async (request, reply) => {
      const user = request.user!;
      const { type, config, is_default } = request.body;

      if (!["email", "webhook"].includes(type)) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Type must be 'email' or 'webhook'. Use OAuth for Slack."));
      }
      if (type === "email" && (!config.api_key || !config.from_address)) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Email requires api_key and from_address"));
      }
      if (type === "webhook" && !config.url) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Webhook requires url"));
      }

      // Check for existing
      const existing = await integrationService.getByUserAndType(user.id, type);
      if (existing) {
        return reply.code(409).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `${type} integration already exists`));
      }

      const integration = await integrationService.create(user.id, type, config);
      if (is_default) {
        await integrationService.setDefault(user.id, integration.id);
      }
      return integration;
    });

    server.patch<{
      Params: { id: string };
      Body: { config?: Record<string, unknown>; is_default?: boolean; enabled?: boolean; scope?: Scope; profile_ids?: string[] };
    }>("/v1/integrations/:id", async (request, reply) => {
      const user = request.user!;
      const integration = await integrationService.get(request.params.id);
      if (!integration || integration.user_id !== user.id) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Integration not found"));
      }
      const { config, is_default, enabled, scope, profile_ids } = request.body;
      // Reject cross-user grants up front so a malicious caller can't
      // attach someone else's profile id to their own integration.
      if (profile_ids && profile_ids.length > 0) {
        const bad = await firstUnownedProfileId(user.id, profile_ids);
        if (bad) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `Profile not found: ${bad}`));
        }
      }
      try {
        const updated = await integrationService.update(request.params.id, { config, enabled, scope, profile_ids });
        if (is_default) {
          await integrationService.setDefault(user.id, request.params.id);
        }
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Update failed";
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, message));
      }
    });

    server.delete<{ Params: { id: string } }>(
      "/v1/integrations/:id",
      async (request, reply) => {
        const user = request.user!;
        const integration = await integrationService.get(request.params.id);
        if (!integration || integration.user_id !== user.id) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Integration not found"));
        }
        await integrationService.delete(request.params.id);
        return { status: "deleted", id: request.params.id };
      },
    );

    server.post<{ Params: { id: string } }>(
      "/v1/integrations/:id/test",
      async (request, reply) => {
        const user = request.user!;
        const integration = await integrationService.get(request.params.id);
        if (!integration || integration.user_id !== user.id) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Integration not found"));
        }
        const result = await notificationService.send({
          userId: user.id,
          channel: integration.type as NotificationChannel,
          message: "This is a test notification from Vonzio. If you received this, your integration is working correctly.",
          urgency: "normal",
          source: "platform",
        });
        if (result.success) {
          return { status: "sent", channel: result.channel };
        }
        return reply.code(502).send(errorResponse(ErrorCodes.BAD_GATEWAY, result.error ?? "Test failed"));
      },
    );
  },
  { name: "integration-routes" },
);

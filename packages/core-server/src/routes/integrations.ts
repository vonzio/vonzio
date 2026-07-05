import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { IntegrationService } from "../services/integration-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { ProfileService } from "../services/profile-service.js";
import { MailService, type MailConfig } from "../services/mail-service.js";
import { CalendarService, type CalendarConfig } from "../services/calendar-service.js";
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
      const { type, is_default } = request.body;
      let { config } = request.body;

      if (!["email", "webhook", "mail", "calendar"].includes(type)) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Type must be 'email', 'webhook', 'mail', or 'calendar'. Use OAuth for Slack."));
      }
      if (type === "email" && (!config.api_key || !config.from_address)) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Email requires api_key and from_address"));
      }
      if (type === "webhook" && !config.url) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Webhook requires url"));
      }
      if (type === "mail") {
        // Universal IMAP/SMTP connector (feature 0035). Coerce ports and
        // live-verify BOTH protocols before persisting — a saved-but-dead
        // mailbox is worse than an upfront error in the modal.
        const required = ["imap_host", "smtp_host", "username", "password"] as const;
        for (const k of required) {
          if (typeof config[k] !== "string" || !(config[k] as string).trim()) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `Mail requires ${k}`));
          }
        }
        const mailCfg: MailConfig = {
          imap_host: (config.imap_host as string).trim(),
          imap_port: Number(config.imap_port) || 993,
          smtp_host: (config.smtp_host as string).trim(),
          smtp_port: Number(config.smtp_port) || 465,
          username: (config.username as string).trim(),
          password: config.password as string,
          security: config.security === "starttls" ? "starttls" : "tls",
          from_address: typeof config.from_address === "string" && config.from_address.trim() ? (config.from_address as string).trim() : undefined,
          from_name: typeof config.from_name === "string" && config.from_name.trim() ? (config.from_name as string).trim() : undefined,
          allow_send: config.allow_send !== false,
        };
        try {
          await new MailService().verify(mailCfg);
        } catch (err) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err instanceof Error ? err.message : "Mail verification failed"));
        }
        config = mailCfg as unknown as Record<string, unknown>;
      }
      if (type === "calendar") {
        // CalDAV connector (feature 0037): validate + live-verify (login +
        // list calendars) before persisting. SSRF guarded inside the service.
        const required = ["caldav_url", "username", "password"] as const;
        for (const k of required) {
          if (typeof config[k] !== "string" || !(config[k] as string).trim()) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, `Calendar requires ${k}`));
          }
        }
        const calCfg: CalendarConfig = {
          caldav_url: (config.caldav_url as string).trim(),
          username: (config.username as string).trim(),
          password: config.password as string,
        };
        try {
          await new CalendarService().verify(calCfg);
        } catch (err) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, err instanceof Error ? err.message : "Calendar verification failed"));
        }
        config = calCfg as unknown as Record<string, unknown>;
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
        if (integration.type === "calendar") {
          const cfg = integration.config as unknown as CalendarConfig;
          try {
            const cals = await new CalendarService().listCalendars(cfg);
            return { status: "sent", channel: "calendar", detail: `${cals.length} calendar(s)` };
          } catch (err) {
            return reply.code(502).send(errorResponse(ErrorCodes.BAD_GATEWAY, err instanceof Error ? err.message : "Calendar test failed"));
          }
        }
        if (integration.type === "mail") {
          // Mail isn't a notification channel — test by sending the user
          // an email to their own address THROUGH the connector itself.
          const cfg = integration.config as unknown as MailConfig;
          try {
            await new MailService().send(cfg, {
              to: cfg.from_address || cfg.username,
              subject: "Vonzio mail connector test",
              body: "This is a test email from Vonzio. If you received this, your mail integration is working correctly.",
            });
            return { status: "sent", channel: "mail" };
          } catch (err) {
            return reply.code(502).send(errorResponse(ErrorCodes.BAD_GATEWAY, err instanceof Error ? err.message : "Mail test failed"));
          }
        }
        // Route to the EXACT integration that was clicked. The bare
        // channel form resolves the user's default integration of that
        // type — with multiple Telegram bots (platform + agent-bound)
        // that sent every "Test" through the default bot regardless of
        // which row the button was on.
        const channel =
          integration.type === "telegram"
            ? `telegram:${integration.id}`
            : (integration.type as NotificationChannel);
        const result = await notificationService.send({
          userId: user.id,
          channel,
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

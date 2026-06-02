import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import type { PlaybookService } from "../services/playbook-service.js";
import type { ChainRunner } from "../orchestrator/chain-runner.js";
import type { PlaybookScheduler } from "../services/playbook-scheduler.js";
import { errorResponse, ErrorCodes } from "../errors.js";
import type { NotifyOn, SuccessCriterion } from "@vonzio/shared";
import { CronExpressionParser } from "cron-parser";

function validateCron(schedule: string): boolean {
  try { CronExpressionParser.parse(schedule); return true; } catch { return false; }
}

export interface PlaybookRoutesOptions {
  playbookService: PlaybookService;
  chainRunner: ChainRunner;
  playbookScheduler: PlaybookScheduler;
}

export const playbookRoutes = fp(
  async (server: FastifyInstance, opts: PlaybookRoutesOptions) => {
    const { playbookService, chainRunner, playbookScheduler } = opts;

    // ── Playbooks CRUD ──

    server.get("/v1/playbooks", {
      schema: {
        summary: "List playbooks",
        description: "Returns the authenticated user's playbooks. Each item is a `Playbook`.",
        tags: ["Playbooks"],
      },
    }, async (request) => {
      return playbookService.list(request.user!.id, request.orgContext?.org_id);
    });

    server.post<{ Body: { name: string; profile_id: string; prompt: string; schedule: string; description?: string; chain_config?: Record<string, unknown>; enabled?: boolean; trigger_type?: string; notify_on?: string; notification_channels?: string[]; interval_seconds?: number; success_criteria?: unknown[] } }>(
      "/v1/playbooks",
      {
        schema: {
          summary: "Create a playbook",
          description:
            "Schedules a new playbook against a profile. `prompt` is the input the agent receives on each run. " +
            "For `trigger_type='cron'`, `schedule` is a 5-field cron expression (UTC). For `interval`, see " +
            "`interval_seconds`. Set `enabled: true` to make the scheduler pick it up immediately. " +
            "Server clamps `chain_config` to safe bounds (see PlaybookChainConfig schema). Returns the full `Playbook`.",
          tags: ["Playbooks"],
          body: { $ref: "CreatePlaybookInput#" },
        },
      },
      async (request, reply) => {
        try {
          const { name, profile_id, prompt, schedule, description, chain_config, enabled, notify_on, notification_channels, interval_seconds, success_criteria } = request.body;
          const triggerType = (request.body.trigger_type ?? "cron") as "cron" | "webhook" | "interval" | "manual";
          if (!name || !profile_id || !prompt) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "name, profile_id, and prompt are required"));
          }
          if (triggerType === "cron" && !schedule) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "schedule is required for cron trigger type"));
          }
          if (triggerType === "cron" && !validateCron(schedule)) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Invalid cron expression"));
          }
          const webhookToken = triggerType === "webhook" ? nanoid(32) : undefined;
          const playbook = await playbookService.create(request.user!.id, {
            name,
            profile_id,
            prompt,
            schedule,
            description,
            chain_config: chain_config as Record<string, number> | undefined,
            enabled,
            trigger_type: triggerType,
            webhook_token: webhookToken,
            notify_on: notify_on as NotifyOn | undefined,
            notification_channels,
            interval_seconds,
            success_criteria: success_criteria as SuccessCriterion[] | undefined,
          }, request.orgContext?.org_id);
          if (playbook.enabled) {
            await playbookScheduler.recomputeNextRun(playbook.id);
          }
          return reply.code(201).send(playbook);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to create playbook";
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, message));
        }
      },
    );

    server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      "/v1/playbooks/:id",
      {
        schema: {
          summary: "Update a playbook",
          description:
            "Patches any field on the playbook. Cron `schedule` changes are re-validated. The scheduler's " +
            "next-run time is recomputed automatically.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string", example: "pb_Hg0Q2OvYGi7SiBZ7usVVJ" } } },
          body: { type: "object", additionalProperties: true, description: "Any subset of CreatePlaybookInput fields." },
        },
      },
      async (request, reply) => {
        try {
          const body = request.body as Record<string, unknown>;
          const patchTriggerType = (body.trigger_type as string | undefined) ?? undefined;
          if (body.schedule && (!patchTriggerType || patchTriggerType === "cron") && !validateCron(body.schedule as string)) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Invalid cron expression"));
          }
          const updated = await playbookService.update(
            request.params.id,
            request.user!.id,
            body as Parameters<PlaybookService["update"]>[2],
            request.orgContext?.org_id,
          );
          if (!updated) {
            return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Playbook not found"));
          }
          await playbookScheduler.recomputeNextRun(updated.id);
          return updated;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to update playbook";
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, message));
        }
      },
    );

    server.delete<{ Params: { id: string } }>(
      "/v1/playbooks/:id",
      {
        schema: {
          summary: "Delete a playbook",
          description: "Removes the playbook (and stops it from being scheduled). Returns `{ status: 'deleted', playbook_id }`.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async (request, reply) => {
        const deleted = await playbookService.delete(request.params.id, request.user!.id, request.orgContext?.org_id);
        if (!deleted) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Playbook not found"));
        }
        return { status: "deleted", playbook_id: request.params.id };
      },
    );

    // ── Run management ──

    server.post<{ Params: { id: string } }>(
      "/v1/playbooks/:id/run",
      {
        schema: {
          summary: "Manually fire a playbook",
          description:
            "Triggers an immediate run (out-of-schedule). Returns `202 Accepted` and runs in the background — " +
            "poll `/v1/playbooks/:id/runs` for status. Useful for one-off testing or backfills.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async (request, reply) => {
        const playbook = await playbookService.get(request.params.id, {
          userId: request.user!.id,
          orgId: request.orgContext?.org_id,
        });
        if (!playbook) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Playbook not found"));
        }
        // Fire in background, return immediately
        chainRunner.execute(playbook, request.user!.id).catch((err) => {
          server.log.error({ playbookId: playbook.id, error: String(err) }, "Playbook trigger failed");
        });
        return reply.code(202).send({ status: "started", playbook_id: playbook.id });
      },
    );

    server.get<{ Params: { id: string } }>(
      "/v1/playbooks/:id/runs",
      {
        schema: {
          summary: "List runs for a specific playbook",
          description: "Returns the per-playbook run history in reverse-chronological order. Each item is a `PlaybookRun`.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async (request, reply) => {
        const playbook = await playbookService.get(request.params.id, {
          userId: request.user!.id,
          orgId: request.orgContext?.org_id,
        });
        if (!playbook) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Playbook not found"));
        }
        return playbookService.listRuns(request.params.id);
      },
    );

    server.get("/v1/playbook-runs", {
      schema: {
        summary: "List all playbook runs (cross-playbook)",
        description: "Returns recent runs across every playbook the user owns. Each item is a `PlaybookRun`.",
        tags: ["Playbooks"],
      },
    }, async (request) => {
      // playbook_runs has no org_id column today — ownership is
      // inherited via the parent playbook. Pass orgId so the service
      // JOINs through playbooks and filters server-side; OSS callers
      // leave orgContext undefined → no JOIN filter, no change.
      return playbookService.listRunsForUser(
        request.user!.id,
        undefined,
        undefined,
        request.orgContext?.org_id,
      );
    });

    server.get<{ Params: { id: string } }>(
      "/v1/playbook-runs/:id",
      {
        schema: {
          summary: "Get a single playbook run",
          description: "Returns the run detail including status, chains/turns/cost, decision result, and any error.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async (request, reply) => {
        const run = await playbookService.getRun(request.params.id);
        if (!run || run.user_id !== request.user!.id) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Run not found"));
        }
        // Org boundary check: when an OrgContext is set, the parent
        // playbook must belong to the same tenant. Without this an
        // org admin could read another tenant's runs via a smuggled
        // run_id (same user_id, different org).
        if (request.orgContext?.org_id) {
          const parent = await playbookService.get(run.playbook_id, {
            userId: request.user!.id,
            orgId: request.orgContext.org_id,
          });
          if (!parent) {
            return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Run not found"));
          }
        }
        return run;
      },
    );

    server.post<{ Params: { id: string } }>(
      "/v1/playbook-runs/:id/cancel",
      {
        schema: {
          summary: "Cancel an in-flight playbook run",
          description: "Signals the chain runner to stop. Returns `400` if the run isn't active.",
          tags: ["Playbooks"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async (request, reply) => {
        const run = await playbookService.getRun(request.params.id);
        if (!run || run.user_id !== request.user!.id) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Run not found"));
        }
        // Same org-scope check as the GET above — prevent cross-tenant
        // cancel via a smuggled run_id.
        if (request.orgContext?.org_id) {
          const parent = await playbookService.get(run.playbook_id, {
            userId: request.user!.id,
            orgId: request.orgContext.org_id,
          });
          if (!parent) {
            return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Run not found"));
          }
        }
        const cancelled = chainRunner.cancelRun(request.params.id);
        if (!cancelled) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Run is not active"));
        }
        return { status: "cancelling", run_id: request.params.id };
      },
    );

    // ── Scheduler control ──

    server.get("/v1/playbooks/scheduler/status", async () => {
      return { paused: playbookScheduler.isPaused() };
    });

    server.post("/v1/playbooks/scheduler/pause", async (request, reply) => {
      if (request.user!.role !== "admin") {
        return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Admin only"));
      }
      playbookScheduler.pause();
      return { status: "paused" };
    });

    server.post("/v1/playbooks/scheduler/resume", async (request, reply) => {
      if (request.user!.role !== "admin") {
        return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Admin only"));
      }
      playbookScheduler.resume();
      return { status: "resumed" };
    });
  },
  { name: "playbook-routes" },
);

// ── Webhook trigger (public, outside auth scope) ──

export interface PlaybookWebhookOptions {
  playbookService: PlaybookService;
  chainRunner: ChainRunner;
}

export const playbookWebhookRoute = fp(
  async (server: FastifyInstance, opts: PlaybookWebhookOptions) => {
    const { playbookService, chainRunner } = opts;

    server.post<{ Params: { token: string } }>(
      "/v1/webhook/playbook/:token",
      async (request, reply) => {
        const playbook = await playbookService.getByWebhookToken(request.params.token);
        if (!playbook) {
          return reply.code(404).send({ error: "Not found" });
        }
        if (!playbook.enabled || playbook.trigger_type !== "webhook") {
          return reply.code(400).send({ error: "Playbook not configured for webhook triggers" });
        }

        // Fire in background
        chainRunner.execute(playbook, playbook.user_id).catch(() => {});
        return reply.code(202).send({ status: "triggered", playbook_id: playbook.id });
      },
    );
  },
  { name: "playbook-webhook-route" },
);

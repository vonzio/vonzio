import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { TaskService, ForbiddenError } from "../services/task-service.js";
import { ProfileService } from "../services/profile-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import type { TaskMode, TaskStatus } from "@vonzio/shared";
import { submitTaskSchema, sendValidationError } from "./validation.js";
import { getActiveOrgId } from "../lib/active-org.js";

export interface TaskRoutesOptions {
  taskService: TaskService;
  profileService: ProfileService;
  /**
   * Optional SaaS hook — when present, called after a task is
   * accepted so cp-server can link it to the active org (from
   * `request.orgContext`). OSS deployments leave this undefined.
   * Failure surfaces as 500 so a downstream workspace launch can't
   * silently lose its org affinity.
   */
  recordTaskOrg?: (taskId: string, orgId: string) => Promise<void>;
  /**
   * SaaS hook (same as profiles): returns the subset of the candidate profile
   * ids visible in the active org, or null when no org filter applies (OSS).
   * Used to keep task visibility within the active org's tenant boundary.
   */
  visibleProfileIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
    candidates: string[],
  ) => Promise<Set<string> | null>;
}

export const taskRoutes = fp(
  async (server: FastifyInstance, opts: TaskRoutesOptions) => {
    const { taskService } = opts;

    server.post("/v1/tasks", {
      schema: {
        summary: "Submit a one-shot task",
        description:
          "Fires an agent run against a profile. Returns immediately with the `Task` row; for `mode='batch'` " +
          "the run continues in the background — poll `/v1/tasks/:id` for status. For `mode='session'`, the task " +
          "becomes a long-lived workspace and is reachable via `/v1/workspaces/:session_id`. For `mode='stream'`, " +
          "open the WebSocket at `/ws` to follow output live. Body validated by `SubmitTaskInput`.",
        tags: ["Tasks"],
        body: { $ref: "SubmitTaskInput#" },
      },
    }, async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send(errorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
      }

      const parsed = submitTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }

      try {
        // Same scoping as read/cancel: respects an API token's allow-list AND
        // the active-org filter. undefined = admin in OSS → may use any of
        // their own profiles (fall back to the full list).
        const allowedProfileIds = (await getUserProfileIds(request))
          ?? (await opts.profileService.list(request.user.id)).map((p) => p.id);
        const result = await taskService.submit(parsed.data, allowedProfileIds);
        // Link the task to the caller's active org if a SaaS layer
        // has wired the hook. Awaits before sending the response so
        // the orchestrator's resolveOrgIdForTask call (which can
        // race the task's first dispatch) always sees the row.
        const orgId = request.orgContext?.org_id;
        if (orgId && opts.recordTaskOrg) {
          await opts.recordTaskOrg(result.task_id, orgId);
        }
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, err.message));
        }
        throw err;
      }
    });

    async function getUserProfileIds(request: import("fastify").FastifyRequest): Promise<string[] | undefined> {
      const user = request.user!;
      // Admin sees all ONLY in OSS (no org context). In SaaS the active org is
      // the tenant boundary, so even admin is scoped to their own profiles —
      // otherwise an admin acting in org A could read/cancel org B's tasks.
      if (user.role === "admin" && !request.orgContext?.org_id) return undefined;
      // API token → its baked allow-list; otherwise the user's profiles.
      let ids = user.allowedProfileIds?.length
        ? user.allowedProfileIds
        : (await opts.profileService.list(user.id)).map((p) => p.id);
      // SaaS: keep visibility within the active org — applied to BOTH the
      // token and session paths, so a multi-org user (or a token used under
      // another org context) can't reach tasks across orgs.
      if (opts.visibleProfileIdsForOrg) {
        const visible = await opts.visibleProfileIdsForOrg(user.id, getActiveOrgId(), ids);
        if (visible) ids = ids.filter((id) => visible.has(id));
      }
      return ids;
    }

    server.get<{
      Querystring: {
        status?: TaskStatus;
        mode?: TaskMode;
        page?: string;
        limit?: string;
      };
    }>("/v1/tasks", {
      schema: {
        summary: "List tasks",
        description:
          "Returns tasks visible to the caller. Scoped to the user's profiles unless the caller is admin. " +
          "Supports filtering by `status` and `mode`, plus `page`/`limit` pagination.",
        tags: ["Tasks"],
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled"] },
            mode: { type: "string", enum: ["batch", "session", "stream"] },
            page: { type: "string" },
            limit: { type: "string" },
          },
        },
      },
    }, async (request) => {
      const { status, mode, page, limit } = request.query;
      const profileIds = await getUserProfileIds(request);
      return taskService.list({
        profileIds,
        status,
        mode,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
    });

    server.get<{ Params: { id: string } }>("/v1/tasks/:id", {
      schema: {
        summary: "Get a task",
        description: "Returns the task by id. 404 when missing or not in any of the caller's profile IDs.",
        tags: ["Tasks"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      const task = await taskService.get(request.params.id);
      if (!task) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Task not found"));
      }
      // Verify the task's profile belongs to this user
      const profileIds = await getUserProfileIds(request);
      if (profileIds && !profileIds.includes(task.profile_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Task not found"));
      }
      return task;
    });

    server.delete<{ Params: { id: string } }>("/v1/tasks/:id", {
      schema: {
        summary: "Cancel a task",
        description: "Cancels a queued or running task. Returns 404 if already completed/missing.",
        tags: ["Tasks"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      const task = await taskService.get(request.params.id);
      if (!task) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Task not found or already completed"));
      }
      const profileIds = await getUserProfileIds(request);
      if (profileIds && !profileIds.includes(task.profile_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Task not found"));
      }
      await taskService.cancel(request.params.id);
      return { status: "cancelled", task_id: request.params.id };
    });
  },
  { name: "task-routes" },
);

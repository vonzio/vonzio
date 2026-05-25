import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { TaskService, ForbiddenError } from "../services/task-service.js";
import { ProfileService } from "../services/profile-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import type { TaskMode, TaskStatus } from "@vonzio/shared";
import { submitTaskSchema, sendValidationError } from "./validation.js";

export interface TaskRoutesOptions {
  taskService: TaskService;
  profileService: ProfileService;
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
        const profiles = await opts.profileService.list(request.user.id);
        const result = await taskService.submit(
          parsed.data,
          profiles.map((p) => p.id),
        );
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
      if (user.role === "admin") return undefined; // admin sees all
      if (user.allowedProfileIds?.length) return user.allowedProfileIds; // API token
      const profiles = await opts.profileService.list(user.id);
      return profiles.map((p) => p.id);
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

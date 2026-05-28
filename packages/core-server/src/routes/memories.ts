import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { MemoryService } from "../services/memory-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import {
  createMemorySchema,
  updateMemorySchema,
  searchMemorySchema,
  sendValidationError,
} from "./validation.js";

export interface MemoryRoutesOptions {
  memoryService: MemoryService;
}

export const memoryRoutes = fp(
  async (server: FastifyInstance, opts: MemoryRoutesOptions) => {
    const { memoryService } = opts;

    server.get("/v1/memories", async (request) => {
      const query = request.query as Record<string, string>;
      const type = query.type || undefined;
      const profileId = query.profile_id || undefined;
      const limit = query.limit ? Number(query.limit) : 50;
      const offset = query.offset ? Number(query.offset) : 0;
      return memoryService.list(request.user!.id, {
        type,
        profileId,
        allScopes: !profileId,
        limit,
        offset,
        orgId: request.orgContext?.org_id,
      });
    });

    server.get("/v1/memories/search", async (request, reply) => {
      const parsed = searchMemorySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      const { q, type, profile_id, limit } = parsed.data;
      return memoryService.search(request.user!.id, {
        query: q,
        type,
        profile_id,
        limit,
      }, request.orgContext?.org_id);
    });

    server.get<{ Params: { id: string } }>(
      "/v1/memories/:id",
      async (request, reply) => {
        const memory = await memoryService.get(request.params.id, {
          userId: request.user!.id,
          orgId: request.orgContext?.org_id,
        });
        if (!memory) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Memory not found"));
        }
        return memory;
      },
    );

    server.post("/v1/memories", async (request, reply) => {
      const parsed = createMemorySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      const memory = await memoryService.create(request.user!.id, parsed.data, request.orgContext?.org_id);
      return reply.code(201).send(memory);
    });

    server.patch<{ Params: { id: string } }>(
      "/v1/memories/:id",
      async (request, reply) => {
        const parsed = updateMemorySchema.safeParse(request.body);
        if (!parsed.success) {
          return sendValidationError(reply, parsed.error);
        }
        const updated = await memoryService.update(
          request.params.id,
          request.user!.id,
          parsed.data,
          request.orgContext?.org_id,
        );
        if (!updated) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Memory not found"));
        }
        return updated;
      },
    );

    server.delete<{ Params: { id: string } }>(
      "/v1/memories/:id",
      async (request, reply) => {
        const deleted = await memoryService.delete(
          request.params.id,
          request.user!.id,
          request.orgContext?.org_id,
        );
        if (!deleted) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Memory not found"));
        }
        return { deleted: true };
      },
    );

    server.delete("/v1/memories", async (request) => {
      const query = request.query as Record<string, string>;
      const type = query.type || undefined;
      const profileId = query.profile_id || undefined;
      const count = await memoryService.bulkDelete(request.user!.id, {
        type,
        profileId,
        orgId: request.orgContext?.org_id,
      });
      return { deleted: count };
    });
  },
  { name: "memory-routes" },
);

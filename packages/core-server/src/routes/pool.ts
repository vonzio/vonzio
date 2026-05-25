import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { ContainerPool } from "../container/pool.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface PoolRoutesOptions {
  pool: ContainerPool;
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
}

function requireAdmin(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
  if (!request.user || request.user.role !== "admin") {
    return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Admin access required"));
  }
}

export const poolRoutes = fp(
  async (server: FastifyInstance, opts: PoolRoutesOptions) => {
    server.get("/v1/pool", { preHandler: requireAdmin as any }, async () => {
      return {
        idle: opts.pool.idleCount,
        busy: opts.pool.busyCount,
        total: opts.pool.totalCount,
      };
    });

    server.get("/v1/pool/containers", { preHandler: requireAdmin as any }, async () => {
      const containers = await opts.containerManager.listManagedContainers();
      const poolMap = opts.pool.trackedContainers;
      const sessionMap = opts.sessionRegistry.containerSessionMap;

      const enriched = containers.map((c) => {
        const poolStatus = poolMap.get(c.id);
        const sessionId = sessionMap.get(c.id);

        let assignment: "pool-idle" | "pool-busy" | "session" | "orphan";
        if (sessionId) {
          assignment = "session";
        } else if (poolStatus === "idle") {
          assignment = "pool-idle";
        } else if (poolStatus === "busy") {
          assignment = "pool-busy";
        } else {
          assignment = "orphan";
        }

        return {
          ...c,
          assignment,
          session_id: sessionId ?? null,
          pool_status: poolStatus ?? null,
        };
      });

      return { containers: enriched };
    });

    server.delete<{ Params: { id: string } }>("/v1/pool/containers/:id", { preHandler: requireAdmin as any }, async (request) => {
      await opts.containerManager.removeContainer(request.params.id, true);
      return { status: "removed", container_id: request.params.id };
    });
  },
  { name: "pool-routes" },
);

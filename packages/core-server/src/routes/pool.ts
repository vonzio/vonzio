import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { ContainerPool } from "../container/pool.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import { CONTAINER_MODE_LABEL, ContainerMode } from "../container/docker-manager.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import { adminReadHook, type RoleResolver } from "../auth/user-auth.js";

export interface PoolRoutesOptions {
  pool: ContainerPool;
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
  /** Resolves a token caller's REAL db role, so an admin's API token (e.g.
   *  `vonzio ops`) can read pool state. When omitted, read routes fall back to
   *  session-only admin (the synthetic `api_token` role never passes). */
  resolveUserRole?: RoleResolver;
}

function requireAdmin(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
  if (!request.user || request.user.role !== "admin") {
    return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Admin access required"));
  }
}

export const poolRoutes = fp(
  async (server: FastifyInstance, opts: PoolRoutesOptions) => {
    // Read-only routes admit an admin's API token (real-role resolved); mutating
    // routes below stay strictly session-admin via `requireAdmin`.
    const requireAdminRead = opts.resolveUserRole ? adminReadHook(opts.resolveUserRole) : requireAdmin;

    server.get("/v1/pool", { preHandler: requireAdminRead as any }, async () => {
      return {
        idle: opts.pool.idleCount,
        busy: opts.pool.busyCount,
        total: opts.pool.totalCount,
      };
    });

    server.get("/v1/pool/containers", { preHandler: requireAdminRead as any }, async () => {
      const containers = await opts.containerManager.listManagedContainers();
      const poolMap = opts.pool.trackedContainers;
      const sessionMap = opts.sessionRegistry.containerSessionMap;
      // The DB is authoritative for session ownership: a container can be in a
      // workspace row but briefly absent from the in-memory map (create/
      // reassign window). Without this it would be mislabelled "orphan" — and
      // an admin could prune a live container by mistake. Mirrors the reaper's
      // keep-set. Fail closed (treat as "all owned") if the DB read errors.
      let dbContainerIds: Set<string>;
      try {
        dbContainerIds = await opts.sessionRegistry.dbContainerIds();
      } catch {
        dbContainerIds = new Set(containers.map((c) => c.id));
      }

      const enriched = containers.map((c) => {
        const poolStatus = poolMap.get(c.id);
        const sessionId = sessionMap.get(c.id);
        const mode = c.labels?.[CONTAINER_MODE_LABEL];

        let assignment: "pool-idle" | "pool-busy" | "session" | "infra" | "orphan";
        if (mode === ContainerMode.VpnSidecar || mode === ContainerMode.EgressProxy) {
          assignment = "infra";
        } else if (sessionId || dbContainerIds.has(c.id)) {
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

    server.post("/v1/pool/containers/prune", { preHandler: requireAdmin as any }, async () => {
      const removed = await opts.pool.pruneOrphans();
      return { status: "pruned", removed, count: removed.length };
    });

    server.delete<{ Params: { id: string } }>("/v1/pool/containers/:id", { preHandler: requireAdmin as any }, async (request) => {
      await opts.containerManager.removeContainer(request.params.id, true);
      return { status: "removed", container_id: request.params.id };
    });
  },
  { name: "pool-routes" },
);

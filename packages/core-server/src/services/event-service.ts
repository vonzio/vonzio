import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { DrizzleDB } from "../db/index.js";
import { createTracker, type Tracker, type RouteEvent } from "../lib/event-tracker/index.js";
import type { Logger } from "../orchestrator/orchestrator.js";

export const ROUTE_EVENTS: RouteEvent[] = [
  { method: "POST", path: "/v1/profiles", event: "profile.created" },
  { method: "POST", path: "/v1/playbooks", event: "playbook.created" },
  { method: "POST", path: "/v1/integrations", event: "integration.connected",
    properties: (req) => {
      const body = req.body as { type?: string } | undefined;
      return body?.type ? { type: body.type } : null;
    },
  },
  { method: "POST", path: "/v1/secrets", event: "secret.created" },
];

export function getUserIdFromRequest(req: FastifyRequest): string | null {
  return req.user?.id ?? null;
}

export function createEventTracker(db: DrizzleDB, log?: Logger): Tracker {
  return createTracker({
    log: log ? { error: (obj, msg) => log.error(obj as Record<string, unknown>, msg ?? "") } : undefined,
    write: async (e) => {
      await db.execute(sql`
        INSERT INTO events (user_id, org_id, session_id, event, source, properties, ip, user_agent, created_at)
        VALUES (
          ${e.user_id},
          ${e.org_id ?? null},
          ${e.session_id},
          ${e.event},
          ${e.source},
          ${e.properties ? JSON.stringify(e.properties) : null}::jsonb,
          ${e.ip},
          ${e.user_agent},
          ${e.created_at}
        )
      `);
    },
  });
}

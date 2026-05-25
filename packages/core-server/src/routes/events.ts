import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import type { Tracker } from "../lib/event-tracker/index.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface EventRoutesOptions {
  tracker: Tracker;
}

export interface AdminEventRoutesOptions {
  db: DrizzleDB;
}

function clientIp(req: FastifyRequest): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]?.trim();
  if (Array.isArray(fwd)) return fwd[0];
  return req.ip;
}

export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (server: FastifyInstance, opts) => {
  const { tracker } = opts;

  server.post<{ Body: { event?: string; properties?: Record<string, unknown>; path?: string } }>(
    "/v1/events",
    async (request, reply) => {
      const { event, properties, path } = request.body ?? {};
      if (!event || typeof event !== "string" || event.length > 100) {
        return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "event required (<=100 chars)"));
      }
      tracker.track({
        event,
        source: "client",
        userId: request.user?.id ?? null,
        properties: { ...(properties ?? {}), ...(path ? { path } : {}) },
        ip: clientIp(request),
        userAgent: request.headers["user-agent"] as string | undefined,
      });
      return reply.code(202).send({ status: "accepted" });
    },
  );
};

export const adminEventRoutes: FastifyPluginAsync<AdminEventRoutesOptions> = async (server: FastifyInstance, opts) => {
  const { db } = opts;

  server.get<{
    Querystring: { user_id?: string; event?: string; source?: string; since?: string; until?: string; limit?: string };
  }>("/admin/events", async (request) => {
    const { user_id, event, source, since, until } = request.query;
    const limit = Math.min(parseInt(request.query.limit ?? "500", 10) || 500, 2000);

    const conditions = [sql`1=1`];
    if (user_id) conditions.push(sql`user_id = ${user_id}`);
    if (event) conditions.push(sql`event LIKE ${event + "%"}`);
    if (source) conditions.push(sql`source = ${source}`);
    if (since) conditions.push(sql`created_at >= ${since}`);
    if (until) conditions.push(sql`created_at <= ${until}`);

    const where = conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`));

    const rows = await db.execute(sql`
      SELECT e.id, e.user_id, u.email AS user_email, u.name AS user_name,
             e.session_id, e.event, e.source, e.properties, e.ip, e.user_agent, e.created_at
      FROM events e
      LEFT JOIN "user" u ON u.id = e.user_id
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT ${limit}
    `);
    return { events: rows.rows };
  });

  server.get<{ Querystring: { since?: string } }>("/admin/events/funnel", async (request) => {
    const since = request.query.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const rows = await db.execute<{ event: string; users: number }>(sql`
      SELECT event, COUNT(DISTINCT user_id)::int AS users
      FROM events
      WHERE created_at >= ${since}
        AND user_id IS NOT NULL
        AND event IN ('user.signed_up', 'user.logged_in', 'profile.created', 'playbook.created', 'integration.connected')
      GROUP BY event
    `);
    const counts = Object.fromEntries((rows.rows as Array<{ event: string; users: number }>).map((r) => [r.event, Number(r.users)]));
    return {
      since,
      steps: [
        { key: "user.signed_up", label: "Signed up", users: counts["user.signed_up"] ?? 0 },
        { key: "user.logged_in", label: "Logged in", users: counts["user.logged_in"] ?? 0 },
        { key: "profile.created", label: "Created a profile", users: counts["profile.created"] ?? 0 },
        { key: "playbook.created", label: "Created a playbook", users: counts["playbook.created"] ?? 0 },
        { key: "integration.connected", label: "Connected an integration", users: counts["integration.connected"] ?? 0 },
      ],
    };
  });
};

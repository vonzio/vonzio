import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Tracker } from "./types.js";

export interface RouteEvent {
  /** Fastify route pattern with leading slash, e.g. "/v1/profiles" */
  path: string;
  method: string;
  event: string;
  /** Extract properties from the request after the response is sent. */
  properties?: (req: FastifyRequest) => Record<string, unknown> | null | undefined;
  /** Only emit for these status codes (default: 2xx). */
  successStatus?: (status: number) => boolean;
}

export interface EventTrackerPluginOptions {
  tracker: Tracker;
  /** Route → event mapping for auto-emission on successful responses. */
  routeEvents?: RouteEvent[];
  /** Extract user id from request (for enrichment). */
  getUserId?: (req: FastifyRequest) => string | null | undefined;
}

function clientIp(req: FastifyRequest): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]?.trim();
  if (Array.isArray(fwd)) return fwd[0];
  return req.ip;
}

function defaultSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export const eventTrackerPlugin = fp<EventTrackerPluginOptions>(
  async (server: FastifyInstance, opts) => {
    const { tracker, routeEvents = [], getUserId } = opts;

    const byKey = new Map<string, RouteEvent>();
    for (const re of routeEvents) {
      byKey.set(`${re.method.toUpperCase()} ${re.path}`, re);
    }

    server.addHook("onResponse", async (request, reply) => {
      const routeKey = `${request.method} ${request.routeOptions?.url ?? request.url}`;
      const match = byKey.get(routeKey);
      if (!match) return;

      const statusCheck = match.successStatus ?? defaultSuccess;
      if (!statusCheck(reply.statusCode)) return;

      tracker.track({
        event: match.event,
        source: "server",
        userId: getUserId?.(request) ?? null,
        properties: match.properties?.(request) ?? null,
        ip: clientIp(request),
        userAgent: request.headers["user-agent"] as string | undefined,
      });
    });
  },
  { name: "event-tracker" },
);

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { DeviceService } from "../services/device-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface DeviceRoutesOptions {
  deviceService: DeviceService;
}

/**
 * Unauthenticated device-flow endpoints (the CLI has no session yet).
 * Register at the top level, like the OAuth callbacks.
 *  - POST /device/code  — start a flow, returns device_code + user_code.
 *  - POST /device/token — poll; returns access_token once approved.
 */
export const devicePublicRoutes = fp(
  async (server: FastifyInstance, opts: DeviceRoutesOptions) => {
    server.post<{ Body: { client_name?: string } }>("/device/code", async (request) => {
      return opts.deviceService.requestCode(request.body?.client_name);
    });

    server.post<{ Body: { device_code?: string } }>("/device/token", async (request, reply) => {
      const deviceCode = request.body?.device_code;
      if (!deviceCode) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await opts.deviceService.poll(deviceCode);
      if (result.status === "approved") {
        return { access_token: result.accessToken, token_type: "bearer" };
      }
      // RFC 8628 polling errors are HTTP 400 with an `error` field.
      return reply.code(400).send({ error: result.error });
    });
  },
  { name: "device-public-routes" },
);

/**
 * Session-authed approval endpoint — registered inside the /v1 auth scope.
 * The logged-in dashboard user approves a user_code shown by their CLI.
 */
export const deviceApproveRoutes = fp(
  async (server: FastifyInstance, opts: DeviceRoutesOptions) => {
    server.post<{ Body: { user_code?: string } }>("/v1/device/approve", async (request, reply) => {
      // Approval must be an interactive, human action via the dashboard session.
      // The /v1 scope also admits api_token bearers (synthetic role "api_token");
      // allowing those would let a token holder headlessly self-approve a new
      // device flow and mint a broader token — defeating the human-in-the-loop.
      if (request.user!.role === "api_token") {
        return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Device approval requires an interactive login session."));
      }
      const userCode = request.body?.user_code;
      if (!userCode) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "user_code is required"));
      }
      const orgId = request.orgContext?.org_id ?? null;
      const result = await opts.deviceService.approve(userCode, request.user!.id, orgId);
      if (result.ok) {
        return { status: "approved", client_name: result.clientName };
      }
      const code = result.error === "not_found" ? ErrorCodes.NOT_FOUND : ErrorCodes.BAD_REQUEST;
      const message =
        result.error === "not_found" ? "That code wasn't found — check it and try again."
          : result.error === "expired" ? "That code has expired — start a new login on your device."
            : "That code has already been used.";
      return reply.code(result.error === "not_found" ? 404 : 400).send(errorResponse(code, message));
    });
  },
  { name: "device-approve-routes" },
);

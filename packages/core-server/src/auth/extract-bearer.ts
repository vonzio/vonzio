import type { FastifyReply, FastifyRequest } from "fastify";
import { ErrorCodes, errorResponse } from "../errors.js";

/**
 * Extracts the Bearer token from the Authorization header,
 * falling back to the `token` query parameter (for WebSocket upgrades
 * where browsers cannot send custom headers).
 * Sends 401 and returns null if missing/invalid.
 */
export function extractBearer(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token) return token;
  }

  // Fallback: check query parameter (used by WebSocket connections from browsers)
  const queryToken = (request.query as Record<string, string>)?.token;
  if (queryToken) return queryToken;

  reply.code(401).send(errorResponse(ErrorCodes.UNAUTHORIZED, "Missing or invalid Authorization header"));
  return null;
}

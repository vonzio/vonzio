import type { FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { TokenValidator } from "@vonzio/shared";
import type { Auth } from "./better-auth.js";
export type { Auth } from "./better-auth.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  allowedProfileIds?: string[];
}

/** Check if the user owns the resource, is an admin, or the resource is shared (null user_id). */
export function isOwnerOrAdmin(user: AuthUser, resourceUserId: string | null): boolean {
  if (user.role === "admin") return true;
  if (resourceUserId === null) return true; // shared resource
  if (!resourceUserId) return false;
  return user.id === resourceUserId;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Create a user auth hook for a Fastify scope.
 * Tries Better Auth session cookie first, then API token (Bearer header
 * or ?token= query param) via the injected TokenValidator.
 * Sets request.user on success, returns 401 on failure.
 */
export function userAuthHook(auth: Auth, tokenValidator: TokenValidator) {
  return async function hook(request: FastifyRequest, reply: FastifyReply) {
    // 1. Try Better Auth session cookie
    try {
      const headers = fromNodeHeaders(request.headers);
      const hasCookie = !!(request.headers.cookie);
      const session = await auth.api.getSession({ headers });

      if (!session?.user && request.url?.includes("/stream")) {
        console.log(`[WS AUTH] url=${request.url} hasCookie=${hasCookie} cookie=${(request.headers.cookie ?? "").slice(0, 50)} session=${!!session?.user}`);
      }

      if (session?.user) {
        request.user = {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: (session.user as Record<string, unknown>).role as string ?? "user",
        };
        return;
      }
    } catch {
      // No valid session cookie — try API token
    }

    // 2. Try API token (Bearer header or ?token= query param)
    const authHeader = request.headers.authorization;
    let token: string | undefined;

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else {
      const query = request.query as Record<string, string>;
      token = query?.token;
    }

    if (token) {
      try {
        const validated = await tokenValidator.validate(token);
        if (validated) {
          request.user = {
            id: validated.userId,
            email: "",
            name: validated.tokenName,
            role: "api_token",
            allowedProfileIds: validated.allowedProfileIds,
          };
          return;
        }
      } catch {
        // Validator failed (DB error, etc.) — fall through to 401 rather
        // than surfacing an internal error.
      }
    }

    reply.code(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
  };
}

/**
 * Admin-only hook. Must run after userAuthHook.
 * Returns 403 if user is not an admin.
 */
export async function adminOnlyHook(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || (request.user.role !== "admin" && request.user.role !== "api_token")) {
    return reply.code(403).send({ error: "Forbidden", code: "FORBIDDEN" });
  }
}

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
  /** API-token callers only: the token's per-minute request cap, enforced on
   *  the WS task-submission path (the embeddable chat's channel). */
  rateLimitRpm?: number;
}

/** Check if the user owns the resource, is an admin, or the resource is shared (null user_id). */
export function isOwnerOrAdmin(user: AuthUser, resourceUserId: string | null): boolean {
  if (user.role === "admin") return true;
  if (resourceUserId === null) return true; // shared resource
  if (!resourceUserId) return false;
  return user.id === resourceUserId;
}

/**
 * Authorize access to a tenant-scoped resource (workspace, task, profile,
 * document, credential, …).
 *
 * SECURITY — the tenant boundary:
 *  - SaaS (request.orgContext.org_id is set): the active org IS the boundary.
 *    The resource's org_id must match. The `admin` role does NOT bypass this —
 *    a logged-in admin acting inside an org context is acting as that tenant;
 *    platform-level access happens out-of-band (no org context). Without this,
 *    every id-addressable route that only ran `isOwnerOrAdmin` let a user in
 *    org B reach org A's data (and any admin reach every org).
 *  - OSS (no orgContext): owner-or-admin, unchanged.
 *
 * Resources with a null org_id under an active org context are treated as not
 * belonging to the tenant (deny) — fail closed.
 */
export function authorizeTenantAccess(
  request: FastifyRequest,
  resource: { user_id?: string | null; org_id?: string | null },
): boolean {
  if (!request.user) return false;
  const orgCtxId = request.orgContext?.org_id;
  if (orgCtxId) return (resource.org_id ?? null) === orgCtxId;
  return isOwnerOrAdmin(request.user, resource.user_id ?? null);
}

/**
 * OrgContext is populated by the cp-server (SaaS) OrgContext middleware
 * when it runs. In OSS deployments cp-server isn't loaded so the field
 * stays `undefined` — services treat that as "no org filtering" and fall
 * back to plain user_id-only WHERE clauses. We declare the minimal shape
 * here so OSS-only builds type-check without importing cp-server (which
 * would create a backwards dep). cp-server is free to augment this with
 * additional fields via its own `declare module`.
 */
export interface OrgContext {
  org_id?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    orgContext?: OrgContext;
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
      const session = await auth.api.getSession({ headers });

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
            rateLimitRpm: validated.rateLimitRpm,
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
 *
 * SECURITY: only the real `admin` role passes. `userAuthHook` assigns the
 * synthetic `api_token` role to EVERY validated API token regardless of the
 * owner's actual role, so admitting `api_token` here let any authenticated
 * user mint a token (POST /v1/api-tokens is user-scoped) and reach every
 * /admin/* route — a full privilege escalation across all tenants. API tokens
 * are for programmatic task submission, not admin operations; admin endpoints
 * are reached via the dashboard session cookie. If a machine admin caller is
 * ever needed, resolve the token owner's real DB role first — do not trust the
 * synthetic role.
 */
export async function adminOnlyHook(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.role !== "admin") {
    return reply.code(403).send({ error: "Forbidden", code: "FORBIDDEN" });
  }
}

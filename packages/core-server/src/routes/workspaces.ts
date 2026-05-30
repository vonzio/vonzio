import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { WorkspaceService } from "../services/workspace-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { EventLog } from "../events/event-log.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import { isOwnerOrAdmin } from "../auth/user-auth.js";
import { WORKSPACE_STATUSES, type Workspace, type WorkspaceStatus } from "@vonzio/shared";

export interface WorkspaceRoutesOptions {
  workspaceService: WorkspaceService;
  profileService?: ProfileService;
  eventLog?: EventLog;
  /** Optional — when present, GET responses are enriched with
   *  `attached_tunnel` for the chat header VPN pill. */
  orchestrator?: Pick<Orchestrator, "getActiveTunnelByAgentContainer">;
}

export const workspaceRoutes = fp(
  async (server: FastifyInstance, opts: WorkspaceRoutesOptions) => {
    const { workspaceService, profileService, eventLog, orchestrator } = opts;

    const withTunnel = (w: Workspace): Workspace => {
      if (!orchestrator || !w.container_id) return w;
      const tunnel = orchestrator.getActiveTunnelByAgentContainer(w.container_id);
      return tunnel ? { ...w, attached_tunnel: tunnel } : w;
    };

    server.get<{
      Querystring: {
        status?: WorkspaceStatus;
        page?: string;
        limit?: string;
      };
    }>("/v1/workspaces", {
      schema: {
        summary: "List workspaces",
        description:
          "Returns the user's workspaces. Supports filtering by `status` and pagination via " +
          "`page` + `limit`. Admin users see all workspaces.",
        tags: ["Workspaces"],
        querystring: {
          type: "object",
          properties: {
            // Spread from the same constant the type system uses — don't
            // inline a literal here (we did that once and it drifted).
            status: { type: "string", enum: [...WORKSPACE_STATUSES] },
            page: { type: "string", description: "1-based page number. Default 1." },
            limit: { type: "string", description: "Page size. Default 50, max 200." },
          },
        },
      },
    }, async (request) => {
      const { status, page, limit } = request.query;
      const user = request.user!;
      const result = await workspaceService.list({
        userId: user.role === "admin" ? undefined : user.id,
        // Forward the OrgContext when cp-server has populated it (SaaS).
        // OSS deploys leave this undefined → no behaviour change.
        orgId: request.orgContext?.org_id,
        status,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      if (!orchestrator) return result;
      return { ...result, workspaces: result.workspaces.map(withTunnel) };
    });

    server.get<{ Params: { id: string } }>("/v1/workspaces/:id", {
      schema: {
        summary: "Get a workspace",
        description: "Returns a single `Workspace` by `session_id`. 404 if missing or not accessible.",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Workspace session_id (UUID)." } } },
      },
    }, async (request, reply) => {
      const session = workspaceService.get(request.params.id);
      const sessionOrgId = session?.org_id ?? null;
      const orgCtxId = request.orgContext?.org_id;
      const isAdmin = request.user!.role === "admin";
      // Auth model:
      //  - admin always passes (ops/debugging).
      //  - SaaS (orgCtxId set): require strict org-match. The active
      //    org is the tenant scope; the workspace's owner alone is not
      //    enough — switching orgs must hide the workspace even from
      //    its owner, so a user pasting an old URL while in a different
      //    org context can't keep poking at cross-org state.
      //  - OSS (orgCtxId undefined): owner-or-admin check, unchanged.
      let allowed: boolean;
      if (!session) allowed = false;
      else if (isAdmin) allowed = true;
      else if (orgCtxId) allowed = sessionOrgId === orgCtxId;
      else allowed = session.user_id === request.user!.id;
      if (!session || !allowed) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Session not found"));
      }
      return withTunnel(session);
    });

    server.delete<{ Params: { id: string } }>("/v1/workspaces/:id", {
      schema: {
        summary: "Delete a workspace",
        description:
          "Fully removes the workspace: tears down any live container and drops the DB row. " +
          "Works for both active and expired workspaces (the sidebar surfaces both).",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      // Ownership lookup goes through findOwnerForDelete so that expired
      // workspaces (which aren't in the in-memory registry) still resolve
      // their owner from the DB. Before this, expired workspaces 404'd on
      // delete even though they were visible in the sidebar history view.
      const owner = await workspaceService.findOwnerForDelete(request.params.id);
      const orgCtxId = request.orgContext?.org_id;
      const orgMatch = !!orgCtxId && owner?.orgId === orgCtxId;
      if (!owner || (!orgMatch && !isOwnerOrAdmin(request.user!, owner.userId))) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Session not found"));
      }
      await workspaceService.delete(request.params.id, { orgId: orgCtxId });
      return { status: "deleted", session_id: request.params.id };
    });

    server.patch<{
      Params: { id: string };
      Body: { name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; model_override?: string | null };
    }>("/v1/workspaces/:id", {
      schema: {
        summary: "Update a workspace",
        description:
          "Patches user-mutable fields. Notable: `model_override` (per-workspace model picker — pass `null` to clear), " +
          "`starred`/`pinned`/`archived` for organization, `public_preview` to expose the preview iframe.",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            name: { type: "string" },
            starred: { type: "boolean" },
            pinned: { type: "boolean" },
            archived: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
            public_preview: { type: "boolean" },
            model_override: { type: "string", nullable: true },
          },
        },
      },
    }, async (request, reply) => {
      const session = workspaceService.get(request.params.id);
      const sessionOrgId = session?.org_id ?? null;
      const orgCtxId = request.orgContext?.org_id;
      const orgMatch = !!orgCtxId && sessionOrgId === orgCtxId;
      if (!session || (!orgMatch && !isOwnerOrAdmin(request.user!, session.user_id))) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }
      const updated = await workspaceService.update(request.params.id, request.body as {
        name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; model_override?: string | null;
      }, { orgId: orgCtxId });
      return updated;
    });

    // Event log for a session (auditor view)
    server.get<{ Params: { id: string } }>("/v1/workspaces/:id/events", {
      schema: {
        summary: "Get the workspace event log",
        description:
          "Returns the structured event timeline for this workspace — every token, tool call, " +
          "tool result, and message in order. Each item is a `WorkspaceEvent`.",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      const workspace = workspaceService.get(request.params.id);
      const workspaceOrgId = workspace?.org_id ?? null;
      const orgCtxId = request.orgContext?.org_id;
      const orgMatch = !!orgCtxId && workspaceOrgId === orgCtxId;
      if (!workspace || (!orgMatch && !isOwnerOrAdmin(request.user!, workspace.user_id))) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }
      if (!eventLog) return [];
      return eventLog.read(request.params.id);
    });

    // Generate a smart title using Claude Haiku
    server.post<{ Params: { id: string } }>("/v1/workspaces/:id/generate-title", async (request, reply) => {
      if (!profileService || !eventLog) {
        return reply.code(501).send(errorResponse(ErrorCodes.INTERNAL_ERROR, "Not configured"));
      }

      const workspace = workspaceService.get(request.params.id);
      // Apply the same auth gate as GET /:id — without this, any
      // authenticated user could rename someone else's workspace by
      // calling /generate-title with their session_id.
      const workspaceOrgId = workspace?.org_id ?? null;
      const orgCtxId = request.orgContext?.org_id ?? null;
      const orgMatch = !!orgCtxId && workspaceOrgId === orgCtxId;
      if (!workspace || (!orgMatch && !isOwnerOrAdmin(request.user!, workspace.user_id))) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }

      // Read first user message and last assistant response from event log
      const events = eventLog.read(request.params.id);
      const userMsg = events.find((e) => e.type === "user_message");
      const textEvents = events.filter((e) => e.type === "text");
      const lastText = textEvents[textEvents.length - 1];
      if (!userMsg) {
        return { name: workspace.name ?? "Untitled" };
      }

      const prompt = (userMsg.data.text as string).slice(0, 200);
      const response = (lastText?.data?.text as string ?? "").slice(0, 200);

      // Get API key
      const resolved = await profileService.getResolved(workspace.profile_id);
      const apiKey = resolved?.resolved_api_key;

      if (apiKey) {
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 20,
              messages: [{
                role: "user",
                content: `Generate a very short title (3-6 words, no quotes, no punctuation) summarizing this conversation topic:\n\nUser: ${prompt}\nAssistant: ${response}`,
              }],
            }),
          });
          if (res.ok) {
            const data = await res.json() as { content: Array<{ text: string }> };
            const title = data.content?.[0]?.text?.trim().replace(/^["']|["']$/g, "").replace(/\.$/,"");
            if (title && title.length > 0 && title.length < 60) {
              await workspaceService.update(request.params.id, { name: title });
              return { name: title };
            }
          }
        } catch { /* fall through */ }
      }

      return { name: workspace.name ?? "Untitled" };
    });
  },
  { name: "workspace-routes" },
);

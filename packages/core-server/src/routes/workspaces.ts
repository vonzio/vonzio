import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { WorkspaceService } from "../services/workspace-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { ApiKeyService } from "../services/api-key-service.js";
import type { EventLog } from "../events/event-log.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import { generateTitle } from "../services/title-service.js";
import { authorizeTenantAccess } from "../auth/user-auth.js";
import { WORKSPACE_STATUSES, type Workspace, type WorkspaceStatus, type ContainerManager, type PreviewPortMode } from "@vonzio/shared";
import { encrypt, decrypt } from "../auth/crypto.js";
import { generatePreviewCode } from "../auth/preview-auth.js";

export interface WorkspaceRoutesOptions {
  workspaceService: WorkspaceService;
  profileService?: ProfileService;
  /** Optional — used to validate a per-conversation api_key_id_override
   *  belongs to the caller (cross-key model selection). */
  apiKeyService?: ApiKeyService;
  eventLog?: EventLog;
  /** Optional — when present, GET responses are enriched with
   *  `attached_tunnel` for the chat header VPN pill. */
  orchestrator?: Pick<Orchestrator, "getActiveTunnelByAgentContainer" | "restartWorkspaceContainer">;
  /** Optional — used to probe which ports the container is listening on, for
   *  the preview/expose service picker. */
  containerManager?: Pick<ContainerManager, "listListeningPorts">;
  /** Vault key for encrypting per-port share codes at rest. */
  encryptionKey?: string;
}

export const workspaceRoutes = fp(
  async (server: FastifyInstance, opts: WorkspaceRoutesOptions) => {
    const { workspaceService, profileService, apiKeyService, eventLog, orchestrator, containerManager, encryptionKey } = opts;

    // Resolve a single port's access mode from the workspace's public/code maps.
    const portModeOf = (w: Workspace, port: string): PreviewPortMode =>
      w.public_preview === true || (w.public_ports ?? []).includes(port)
        ? "public"
        : (w.preview_codes ?? {})[port] ? "code" : "private";

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
      // SaaS: the active org is the tenant boundary (org-match, no admin
      // bypass — switching orgs must hide the workspace even from its owner
      // or an admin). OSS (no org context): owner-or-admin.
      if (!session || !authorizeTenantAccess(request, session)) {
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
      if (!owner || !authorizeTenantAccess(request, { user_id: owner.userId, org_id: owner.orgId })) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Session not found"));
      }
      await workspaceService.delete(request.params.id, { orgId: orgCtxId });
      return { status: "deleted", session_id: request.params.id };
    });

    server.post<{ Params: { id: string } }>("/v1/workspaces/:id/restart", {
      schema: {
        summary: "Restart a workspace's container",
        description:
          "Tears down the workspace's running container so the next message recreates a fresh one. " +
          "Applies config baked at creation time (egress allowlist, network, env) without losing the " +
          "conversation — the SDK session resumes and persistent workspace files survive via the volume.",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      const session = workspaceService.get(request.params.id);
      if (!session || !authorizeTenantAccess(request, session)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Session not found"));
      }
      if (!orchestrator?.restartWorkspaceContainer) {
        return reply.code(503).send(errorResponse(ErrorCodes.INTERNAL_ERROR, "Restart unavailable"));
      }
      try {
        await orchestrator.restartWorkspaceContainer(request.params.id);
      } catch (err) {
        if (err && typeof err === "object" && (err as { code?: string }).code === "WORKSPACE_BUSY") {
          return reply.code(409).send(errorResponse(ErrorCodes.CONFLICT, (err as Error).message));
        }
        throw err;
      }
      return { status: "restarting", session_id: request.params.id };
    });

    server.patch<{
      Params: { id: string };
      Body: { name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; public_ports?: string[]; model_override?: string | null; api_key_id_override?: string | null };
    }>("/v1/workspaces/:id", {
      schema: {
        summary: "Update a workspace",
        description:
          "Patches user-mutable fields. Notable: `model_override` (per-workspace model picker — pass `null` to clear), " +
          "`api_key_id_override` (run this conversation on a different key than the profile's — pass `null` to clear), " +
          "`starred`/`pinned`/`archived` for organization, `public_preview` to expose every preview port, " +
          "`public_ports` (array of port strings) to expose specific services publicly.",
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
            public_ports: { type: "array", items: { type: "string" } },
            model_override: { type: "string", nullable: true },
            api_key_id_override: { type: "string", nullable: true },
          },
        },
      },
    }, async (request, reply) => {
      const session = workspaceService.get(request.params.id);
      const orgCtxId = request.orgContext?.org_id;
      if (!session || !authorizeTenantAccess(request, session)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }
      const body = request.body as {
        name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; public_ports?: string[]; model_override?: string | null; api_key_id_override?: string | null;
      };
      // Normalize/validate public_ports: numeric strings, in range, deduped.
      if (body.public_ports !== undefined) {
        const cleaned = Array.from(new Set(body.public_ports.map((p) => String(p).trim())));
        if (cleaned.some((p) => !/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535)) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "public_ports must be valid port numbers"));
        }
        body.public_ports = cleaned;
      }
      // A non-null key override must be a key the caller can actually use —
      // reject ids outside their visibility (own + admin + shared/org).
      if (body.api_key_id_override && apiKeyService) {
        if (!(await apiKeyService.isAccessible(body.api_key_id_override, request.user!.id, request.user!.role))) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Unknown or inaccessible API key"));
        }
      }
      const updated = await workspaceService.update(request.params.id, body, { orgId: orgCtxId });
      return updated;
    });

    // Live list of ports the container is currently listening on, so the
    // dashboard can offer a preview/expose picker across ALL running services
    // (not just whichever port the agent last printed). Each port carries its
    // current public flag for the per-port expose toggles.
    server.get<{ Params: { id: string } }>("/v1/workspaces/:id/ports", {
      schema: {
        summary: "List the container's listening ports",
        description: "Probes the workspace container for listening TCP services (non-loopback). Returns each port with whether it's publicly exposed.",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    }, async (request, reply) => {
      const workspace = workspaceService.get(request.params.id);
      if (!workspace || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }
      // Decrypt a port's share code for the owner UI (this route is owner-authed).
      const codeOf = (port: string): string | null => {
        const entry = (workspace.preview_codes ?? {})[port];
        if (!entry || !encryptionKey) return null;
        try { return decrypt(entry.code_enc, encryptionKey); } catch { return null; }
      };
      if (!containerManager || !workspace.container_id) {
        return { ports: [], public_preview: workspace.public_preview };
      }
      let detected: number[] = [];
      try {
        detected = await containerManager.listListeningPorts(workspace.container_id);
      } catch {
        detected = [];
      }
      return {
        ports: detected.map((port) => {
          const mode = portModeOf(workspace, String(port));
          return {
            port,
            mode,
            public: mode === "public",
            code: mode === "code" ? codeOf(String(port)) : null,
          };
        }),
        public_preview: workspace.public_preview,
      };
    });

    // Set a single preview port's access mode: private | public | code.
    // For "code", a code may be supplied (owner-chosen) or one is generated;
    // the plaintext is returned ONCE here and stored only encrypted.
    server.put<{ Params: { id: string }; Body: { port: string | number; mode: PreviewPortMode; code?: string } }>(
      "/v1/workspaces/:id/preview-access",
      {
        schema: {
          summary: "Set a preview port's access mode",
          description: "private (owner only), public (anyone with the link), or code (anyone with the link + access code).",
          tags: ["Workspaces"],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          body: {
            type: "object",
            required: ["port", "mode"],
            properties: {
              port: { type: ["string", "number"] },
              mode: { type: "string", enum: ["private", "public", "code"] },
              code: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const orgCtxId = request.orgContext?.org_id;
        const workspace = workspaceService.get(request.params.id);
        if (!workspace || !authorizeTenantAccess(request, workspace)) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
        }
        const body = request.body;
        const port = String(body.port).trim();
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid port"));
        }
        const publicPorts = new Set((workspace.public_ports ?? []).map(String));
        const codes: Record<string, { code_enc: string; code_version: number }> = { ...(workspace.preview_codes ?? {}) };
        let issuedCode: string | null = null;

        if (body.mode === "private") {
          publicPorts.delete(port); delete codes[port];
        } else if (body.mode === "public") {
          publicPorts.add(port); delete codes[port];
        } else {
          // code mode — generate or accept a code, bump version to invalidate old cookies.
          if (!encryptionKey) {
            return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Code mode unavailable (no encryption key)"));
          }
          const code = (body.code ?? "").trim() || generatePreviewCode();
          if (code.length < 4 || code.length > 64) {
            return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Code must be 4–64 characters"));
          }
          const prevVersion = codes[port]?.code_version ?? 0;
          codes[port] = { code_enc: encrypt(code, encryptionKey), code_version: prevVersion + 1 };
          publicPorts.delete(port);
          issuedCode = code;
        }

        await workspaceService.update(
          request.params.id,
          { public_ports: Array.from(publicPorts), preview_codes: codes },
          { orgId: orgCtxId },
        );
        return { port, mode: body.mode, code: issuedCode };
      },
    );

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
      if (!workspace || !authorizeTenantAccess(request, workspace)) {
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
      // Same auth gate as GET /:id — without this, any authenticated user
      // could rename someone else's workspace by calling /generate-title.
      if (!workspace || !authorizeTenantAccess(request, workspace)) {
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

      // Title via the workspace's ACTIVE model/provider — honoring the
      // per-workspace key + model overrides. Single shared path (Anthropic /
      // Ollama / OpenAI alike).
      const resolved = await profileService.getResolved(workspace.profile_id, {
        apiKeyIdOverride: workspace.api_key_id_override ?? undefined,
      });
      const title = await generateTitle(prompt, response, {
        apiKey: resolved?.resolved_api_key,
        provider: resolved?.resolved_provider,
        baseUrl: resolved?.resolved_base_url,
        // Prefer the model that actually ran this workspace's last turn — it's
        // consistent with resolved_provider. model_override ?? resolved.model can
        // desync from the provider (profile default model vs a switched-to key)
        // and 404 — see the ws/handler post-turn hook for the full rationale.
        model: workspace.last_run_model ?? workspace.model_override ?? resolved?.model,
      });
      if (title) {
        await workspaceService.update(request.params.id, { name: title });
        return { name: title };
      }

      return { name: workspace.name ?? "Untitled" };
    });
  },
  { name: "workspace-routes" },
);

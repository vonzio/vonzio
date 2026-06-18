import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import fp from "fastify-plugin";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager, TerminalSession } from "@vonzio/shared";
import { authorizeTenantAccess } from "../auth/user-auth.js";

export interface WorkspaceTerminalRoutesOptions {
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
}

/** Hard ceiling on concurrent shells per workspace (abuse / runaway guard). */
const MAX_TERMINALS_PER_WORKSPACE = 12;

/**
 * Interactive multi-terminal console for a workspace container.
 *
 * `GET /v1/workspaces/:id/terminal?term=<terminalId>` (WebSocket). Each
 * distinct `term` id is its own PTY, so a workspace can run several shells at
 * once (VS Code style — a service in one, work in another). The shell runs as
 * the non-root `agent` user (same view the agent has). The socket owns the
 * PTY: closing the socket kills that shell. A reconnect with the SAME term id
 * (e.g. React StrictMode's double-mount) evicts the stale socket rather than
 * spawning a duplicate.
 *
 * Wire protocol:
 *   client → server  JSON text frames:
 *     { type: "stdin",  data: string }       keystrokes
 *     { type: "resize", cols: n, rows: n }   on xterm fit/resize
 *   server → client
 *     binary frames                          raw PTY output (xterm writes them)
 *     { type: "exit", code: number|null }    shell exited (then socket closes)
 */
export const workspaceTerminalRoutes = fp(
  async (server: FastifyInstance, opts: WorkspaceTerminalRoutesOptions) => {
    const { sessionRegistry, containerManager } = opts;

    // key = `${workspaceId}::${terminalId}`. Distinct terminal ids coexist;
    // a same-key reconnect evicts the prior socket (dedupes StrictMode mounts).
    const sockets = new Map<string, WebSocket>();
    const countForWorkspace = (workspaceId: string) => {
      const prefix = `${workspaceId}::`;
      let n = 0;
      for (const k of sockets.keys()) if (k.startsWith(prefix)) n++;
      return n;
    };

    (server as unknown as FastifyInstance & {
      get(
        path: string,
        opts: { websocket: true },
        handler: (socket: WebSocket, request: FastifyRequest) => void,
      ): void;
    }).get("/v1/workspaces/:id/terminal", { websocket: true }, (socket, request) => {
      const user = request.user;
      const { id } = request.params as { id: string };
      const termId = ((request.query as { term?: string } | undefined)?.term ?? "default")
        .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
      const key = `${id}::${termId}`;
      const workspace = sessionRegistry.get(id);
      if (!user || !workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        socket.close(4001, "Unauthorized");
        return;
      }
      const containerId = workspace.container_id;

      // Same terminal id reconnecting → evict the stale socket (its close
      // handler kills its PTY). Distinct ids are left running.
      const prior = sockets.get(key);
      if (prior && prior !== socket) {
        try { prior.close(1000, "Superseded"); } catch { /* noop */ }
      }
      if (!sockets.has(key) && countForWorkspace(id) >= MAX_TERMINALS_PER_WORKSPACE) {
        socket.close(4031, "Too many terminals for this workspace");
        return;
      }
      sockets.set(key, socket);

      let term: TerminalSession | null = null;
      let closed = false;
      // Input that arrives before the PTY is ready (the async exec setup races
      // the first keystroke / the xterm resize fired on mount).
      const pendingInput: string[] = [];
      let pendingResize: { cols: number; rows: number } | undefined;

      socket.on("message", (data: Buffer) => {
        let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === "stdin" && typeof msg.data === "string") {
          if (term) term.write(msg.data); else pendingInput.push(msg.data);
        } else if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          const cols = msg.cols as number, rows = msg.rows as number;
          if (term) term.resize(cols, rows); else pendingResize = { cols, rows };
        }
      });

      socket.on("close", () => {
        closed = true;
        term?.close();
        if (sockets.get(key) === socket) sockets.delete(key);
      });

      (async () => {
        const status = await containerManager.getContainerStatus(containerId).catch(() => "not_found");
        if (status !== "running") { socket.close(4004, "Container not running"); return; }

        let session: TerminalSession;
        try {
          session = await containerManager.createTerminalSession(containerId, {
            user: "agent",
            cwd: "/workspace",
            cols: pendingResize?.cols,
            rows: pendingResize?.rows,
          });
        } catch {
          socket.close(4011, "Failed to start shell");
          return;
        }
        // The socket closed while we were setting up — don't leak the PTY.
        if (closed) { session.close(); return; }
        term = session;

        session.onData((chunk) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        });
        session.onExit((code) => {
          try {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "exit", code }));
              socket.close(1000, "Shell exited");
            }
          } catch { /* already closing */ }
        });

        // Flush anything buffered during setup.
        if (pendingResize) session.resize(pendingResize.cols, pendingResize.rows);
        for (const data of pendingInput) session.write(data);
        pendingInput.length = 0;
      })();
    });
  },
);

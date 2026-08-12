import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import { ErrorCodes, errorResponse } from "../errors.js";
import { authorizeTenantAccess } from "../auth/user-auth.js";
import { AGENT_UID, AGENT_GID } from "../container/docker-manager.js";
import { ensureContainerRunning } from "../container/ensure-running.js";

export interface WorkspaceFilesRoutesOptions {
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
  /** Per-file upload cap in bytes (config.MAX_UPLOAD_MB). */
  maxUploadBytes: number;
}

/** POSIX-safe single-quote escaping for values interpolated into `sh -c`. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const workspaceFilesRoutes = fp(
  async (server: FastifyInstance, opts: WorkspaceFilesRoutesOptions) => {
    const { sessionRegistry, containerManager, maxUploadBytes } = opts;

    // Shared cap (config.MAX_UPLOAD_MB). throwFileSizeLimit makes the part
    // stream throw when a file exceeds it, so the handler can return a clear
    // 413 instead of silently writing a truncated file.
    await server.register(multipart, {
      limits: { fileSize: maxUploadBytes },
      throwFileSizeLimit: true,
    });

    // Run a shell command directly in the workspace container (owner-scoped).
    // Not a new privilege — the workspace's agent can already run Bash here; this
    // is a direct, no-LLM convenience (the CLI's `!` command). Bounded by a
    // timeout + an output cap; output is combined stdout+stderr.
    server.post<{ Params: { id: string }; Body: { command?: string } }>("/v1/workspaces/:id/exec", {
      schema: {
        summary: "Run a command in the workspace container",
        description: "Executes `sh -c <command>` in the workspace's container and returns combined output (capped + time-bounded).",
        tags: ["Workspaces"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
      },
    }, async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }
      const command = (request.body?.command ?? "").trim();
      if (!command) return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "command is required"));
      // The idle sweep may have paused this container (issue #333) — exec
      // against a paused container 409s, so resume it first. Same below.
      await ensureContainerRunning(containerManager, workspace.container_id, sessionRegistry);

      const MAX_BYTES = 64_000;
      const TIMEOUT_MS = 30_000;
      const it = containerManager.execInContainer(workspace.container_id, ["sh", "-c", command])[Symbol.asyncIterator]();
      const start = Date.now();
      let output = "";
      let truncated = false;
      let timedOut = false;
      try {
        for (;;) {
          const remaining = TIMEOUT_MS - (Date.now() - start);
          if (remaining <= 0) { timedOut = true; break; }
          let timer: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            it.next(),
            new Promise<{ timeout: true }>((r) => { timer = setTimeout(() => r({ timeout: true }), remaining); }),
          ]);
          if (timer) clearTimeout(timer); // don't leak a timer per output line
          if ("timeout" in next) { timedOut = true; break; }
          if (next.done) break;
          output += next.value + "\n";
          if (output.length >= MAX_BYTES) { truncated = true; break; }
        }
      } finally {
        // Stop reading + destroy the attach socket. Note: this does NOT signal
        // the exec'd process — like the agent's own Bash, a runaway command keeps
        // running in the (owner's, ephemeral) container until it exits on its own.
        await it.return?.(undefined).catch(() => {});
      }
      return { output: output.slice(0, MAX_BYTES), truncated, timed_out: timedOut };
    });

    server.get<{
      Params: { id: string };
      Querystring: { path?: string };
    }>("/v1/workspaces/:id/files", async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }

      // Confine listing to /workspace — otherwise `find` could enumerate any
      // directory in the container (e.g. `/`, `/etc`) for the owner.
      const reqPath = request.query.path ?? "/workspace/";
      if (reqPath.includes("..") || !(reqPath === "/workspace" || reqPath.startsWith("/workspace/"))) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "path must be within /workspace"));
      }
      const path = reqPath;
      const cmd = ["find", path, "-maxdepth", "1", "-not", "-path", path, "-printf", "%f\t%s\t%y\n"];
      await ensureContainerRunning(containerManager, workspace.container_id, sessionRegistry);

      const lines: string[] = [];
      for await (const line of containerManager.execInContainer(workspace.container_id, cmd)) {
        lines.push(line);
      }

      const files = lines
        .filter((line) => line.includes("\t"))
        .map((line) => {
          const parts = line.split("\t");
          return {
            name: parts[0],
            size: parseInt(parts[1], 10),
            type: parts[2] === "d" ? "directory" : "file" as "file" | "directory",
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { files, path };
    });

    server.post<{ Params: { id: string } }>("/v1/workspaces/:id/upload", async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found or no container"));
      }
      await ensureContainerRunning(containerManager, workspace.container_id, sessionRegistry);

      const uploaded: { name: string; size: number }[] = [];
      const parts = request.parts();

      // Target directory inside the container. The client sends the folder the
      // user is currently viewing as a `dest` field (ordered before the files).
      // Sanitize hard: confine to /workspace/ and strip any traversal.
      let destDir = "/workspace";

      const maxUploadMb = Math.round(maxUploadBytes / (1024 * 1024));
      try {
       for await (const part of parts) {
        if (part.type === "field" && part.fieldname === "dest") {
          const cleaned = String(part.value ?? "")
            .replace(/\\/g, "/")
            .replace(/\.\./g, "")
            .replace(/\/+/g, "/")
            .replace(/\/$/, "");
          destDir = cleaned === "/workspace" || cleaned.startsWith("/workspace/")
            ? (cleaned || "/workspace")
            : "/workspace";
          continue;
        }
        if (part.type !== "file" || !part.filename) continue;

        // Sanitize filename — allow forward slashes for directory structure
        const safeName = part.filename
          .replace(/\\/g, "/")           // normalize backslashes
          .replace(/\.\./g, "_")         // prevent path traversal
          .split("/")                    // sanitize each path component
          .map((s) => s.replace(/[:*?"<>|]/g, "_").replace(/\s+/g, "_"))
          .filter(Boolean)
          .join("/")
          .slice(0, 300);

        if (!safeName) continue;

        // Read file into buffer
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        // @fastify/multipart flags truncated when the file hit the size limit
        // (belt-and-suspenders alongside the throw caught below).
        if (part.file.truncated) {
          return reply
            .code(413)
            .send(errorResponse(ErrorCodes.BAD_REQUEST, `"${safeName}" exceeds the ${maxUploadMb} MB upload limit`));
        }
        const buffer = Buffer.concat(chunks);

        // Ensure the target subdir exists (base dest + any subdir in the
        // filename), then stream the file in via the tar archive endpoint —
        // a binary bulk copy, far faster than base64-over-exec for big files.
        const dirPart = safeName.includes("/") ? safeName.slice(0, safeName.lastIndexOf("/")) : "";
        const targetDir = dirPart ? `${destDir}/${dirPart}` : destDir;
        const mkdirCmd = ["mkdir", "-p", targetDir];
        for await (const _ of containerManager.execInContainer(workspace.container_id, mkdirCmd)) {
          // drain
        }

        await containerManager.copyToContainer(workspace.container_id, destDir, [
          { name: safeName, content: buffer, uid: AGENT_UID, gid: AGENT_GID },
        ]);

        uploaded.push({ name: safeName, size: buffer.length });
       }
      } catch (err) {
        // @fastify/multipart throws (code FST_REQ_FILE_TOO_LARGE) when a file
        // exceeds the limit. Surface a clear 413 instead of a generic 500 the
        // UI swallows.
        if ((err as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply
            .code(413)
            .send(errorResponse(ErrorCodes.BAD_REQUEST, `File exceeds the ${maxUploadMb} MB upload limit`));
        }
        throw err;
      }

      return { uploaded };
    });

    // Archive one or more paths inside /workspace/. Defaults to zip
    // (cross-platform); pass ?format=tar for an uncompressed tar.
    server.get<{
      Params: { id: string };
      Querystring: { paths?: string | string[]; name?: string; format?: string };
    }>("/v1/workspaces/:id/archive", async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }

      await ensureContainerRunning(containerManager, workspace.container_id, sessionRegistry);
      const raw = request.query.paths;
      const inputPaths = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (inputPaths.length === 0) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "No paths provided"));
      }

      // Sanitize every path: must resolve inside /workspace, no traversal.
      const relPaths: string[] = [];
      for (const p of inputPaths) {
        if (typeof p !== "string" || p.includes("..")) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid path"));
        }
        const abs = p.startsWith("/") ? p : `/workspace/${p}`;
        if (!abs.startsWith("/workspace/") && abs !== "/workspace") {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Path outside /workspace"));
        }
        const rel = abs.replace(/^\/workspace\/?/, "") || ".";
        relPaths.push(rel);
      }

      const format = request.query.format === "tar" ? "tar" : "zip";

      // execInContainer demuxes Docker frames as UTF-8 strings, so it can't
      // stream a binary archive — stage at /tmp, then readFile() (Buffer-safe).
      const containerId = workspace.container_id;
      const ext = format === "zip" ? "zip" : "tar";
      const mime = format === "zip" ? "application/zip" : "application/x-tar";
      const tmpFile = `/tmp/vonzio-archive-${randomUUID()}.${ext}`;

      const buildCmd = format === "zip"
        ? ["sh", "-c", `cd /workspace && zip -rq ${shellQuote(tmpFile)} ${relPaths.map(shellQuote).join(" ")}`]
        : ["tar", "-cf", tmpFile, "-C", "/workspace", ...relPaths];

      try {
        for await (const _ of containerManager.execInContainer(containerId, buildCmd)) {
          // drain stderr/stdout
        }
        const buf = await containerManager.readFile(containerId, tmpFile);

        // Cleanup, fire-and-forget.
        (async () => {
          try {
            for await (const _ of containerManager.execInContainer(containerId, ["rm", "-f", tmpFile])) {
              // drain
            }
          } catch { /* ignore cleanup failures */ }
        })();

        const safeName = (request.query.name ?? "archive").replace(/[^a-zA-Z0-9._-]/g, "_") || "archive";
        reply.header("Content-Type", mime);
        reply.header("Content-Disposition", `attachment; filename="${safeName}.${ext}"`);
        reply.header("Content-Length", String(buf.length));
        return reply.send(buf);
      } catch (err) {
        request.log.error({ err }, "archive build failed");
        return reply.code(500).send(errorResponse(ErrorCodes.INTERNAL_ERROR, "Failed to build archive"));
      }
    });

    server.delete<{
      Params: { id: string };
      Querystring: { path: string };
    }>("/v1/workspaces/:id/files", async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !authorizeTenantAccess(request, workspace)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found or no container"));
      }

      const filePath = (request.query as Record<string, string>).path;
      if (!filePath || filePath.includes("..")) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid file path"));
      }
      // Ensure path is within /workspace/
      const safePath = filePath.startsWith("/workspace/") ? filePath : `/workspace/${filePath}`;

      const cmd = ["rm", "-f", safePath];
      await ensureContainerRunning(containerManager, workspace.container_id, sessionRegistry);
      for await (const _ of containerManager.execInContainer(workspace.container_id, cmd)) {
        // drain
      }

      return { deleted: true };
    });
  },
  { name: "workspace-files-routes" },
);

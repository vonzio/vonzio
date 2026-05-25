import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import { ErrorCodes, errorResponse } from "../errors.js";
import { isOwnerOrAdmin } from "../auth/user-auth.js";

export interface WorkspaceFilesRoutesOptions {
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
}

export const workspaceFilesRoutes = fp(
  async (server: FastifyInstance, opts: WorkspaceFilesRoutesOptions) => {
    const { sessionRegistry, containerManager } = opts;

    await server.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

    server.get<{
      Params: { id: string };
      Querystring: { path?: string };
    }>("/v1/workspaces/:id/files", async (request, reply) => {
      const workspace = sessionRegistry.get(request.params.id);
      if (!workspace || !workspace.container_id || !isOwnerOrAdmin(request.user!, workspace.user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }

      const path = request.query.path ?? "/workspace/output/";
      const cmd = ["find", path, "-maxdepth", "1", "-not", "-path", path, "-printf", "%f\t%s\t%y\n"];

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
      if (!workspace || !workspace.container_id || !isOwnerOrAdmin(request.user!, workspace.user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found or no container"));
      }

      const uploaded: { name: string; size: number }[] = [];
      const parts = request.parts();

      for await (const part of parts) {
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
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString("base64");

        // Create parent directory if needed, then write file
        const dirPart = safeName.includes("/") ? safeName.slice(0, safeName.lastIndexOf("/")) : "";
        if (dirPart) {
          const mkdirCmd = ["mkdir", "-p", `/workspace/output/${dirPart}`];
          for await (const _ of containerManager.execInContainer(workspace.container_id, mkdirCmd)) {
            // drain
          }
        }

        const cmd = ["sh", "-c", `base64 -d > '/workspace/output/${safeName}'`];
        for await (const _ of containerManager.execInContainer(workspace.container_id, cmd, base64)) {
          // drain
        }

        uploaded.push({ name: safeName, size: buffer.length });
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
      if (!workspace || !workspace.container_id || !isOwnerOrAdmin(request.user!, workspace.user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
      }

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

      const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
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
      if (!workspace || !workspace.container_id || !isOwnerOrAdmin(request.user!, workspace.user_id)) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found or no container"));
      }

      const filePath = (request.query as Record<string, string>).path;
      if (!filePath || filePath.includes("..")) {
        return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid file path"));
      }
      // Ensure path is within /workspace/output/
      const safePath = filePath.startsWith("/workspace/output/") ? filePath : `/workspace/output/${filePath}`;

      const cmd = ["rm", "-f", safePath];
      for await (const _ of containerManager.execInContainer(workspace.container_id, cmd)) {
        // drain
      }

      return { deleted: true };
    });
  },
  { name: "workspace-files-routes" },
);

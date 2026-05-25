import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import bcrypt from "bcrypt";
import { extractBearer } from "./extract-bearer.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface AdminAuthOptions {
  passwordHash: string;
}

export const adminAuthPlugin = fp(
  async (server: FastifyInstance, opts: AdminAuthOptions) => {
    server.addHook("onRequest", async (request, reply) => {
      const password = extractBearer(request, reply);
      if (!password) return;

      const valid = await bcrypt.compare(password, opts.passwordHash);
      if (!valid) {
        reply.code(401).send(errorResponse(ErrorCodes.UNAUTHORIZED, "Invalid admin password"));
        return;
      }
    });
  },
  { name: "admin-auth" },
);

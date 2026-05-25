/**
 * Ollama proxy routes. Delete this file to remove Ollama support.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { ApiKeyService } from "../services/api-key-service.js";
import { fetchOllamaModels } from "../services/ollama-service.js";
import { ErrorCodes, errorResponse } from "../errors.js";

export interface OllamaRoutesOptions {
  apiKeyService: ApiKeyService;
}

export const ollamaRoutes = fp(
  async (server: FastifyInstance, opts: OllamaRoutesOptions) => {
    const { apiKeyService } = opts;

    server.get<{ Querystring: { api_key_id: string } }>(
      "/v1/ollama/models",
      async (request, reply) => {
        const { api_key_id } = request.query;
        if (!api_key_id) {
          return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "api_key_id is required"));
        }

        const key = await apiKeyService.getWithSecrets(api_key_id);
        if (!key || key.provider !== "ollama" || !key.api_key) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Ollama key not found"));
        }

        const user = request.user!;
        if (key.user_id && key.user_id !== user.id && user.role !== "admin") {
          return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "Access denied"));
        }

        try {
          const models = await fetchOllamaModels(key.api_key);
          return { models };
        } catch (err) {
          return reply.code(502).send(errorResponse(
            ErrorCodes.BAD_REQUEST,
            err instanceof Error ? err.message : "Failed to fetch Ollama models",
          ));
        }
      },
    );
  },
  { name: "ollama-routes" },
);

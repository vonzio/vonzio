/**
 * Agent template gallery routes (feature 0025). Serves the curated templates
 * loaded from `config/agent-templates/*.md` so the dashboard can render the
 * gallery and seed the new-agent editor.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { loadAgentTemplates } from "../services/agent-template-service.js";

export const agentTemplateRoutes = fp(
  async (server: FastifyInstance) => {
    server.get("/v1/agent-templates", async () => {
      return { templates: loadAgentTemplates() };
    });
  },
  { name: "agent-template-routes" },
);

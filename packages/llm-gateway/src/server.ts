/**
 * llm-gateway: the Claude Agent SDK's Anthropic Messages calls, served by the
 * provider the user connected. See README.md for the modes and env.
 */
import http from "node:http";
import { handleByok, type ByokModeOptions } from "./byok-handler.js";
import { handlePassthrough } from "./passthrough.js";

export type GatewayMode = "openai" | "codex" | "ollama" | "passthrough";

export interface GatewayConfig {
  mode: GatewayMode;
  target: string;
  raw: boolean;
  port: number;
  codexAccountId?: string;
}

const DEFAULT_TARGET: Record<GatewayMode, string> = {
  openai: "https://api.openai.com/v1",
  codex: "",
  ollama: "https://ollama.com",
  passthrough: "https://api.anthropic.com",
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mode = (env.LLM_GATEWAY_MODE || "openai") as GatewayMode;
  if (!(mode in DEFAULT_TARGET)) {
    throw new Error(`LLM_GATEWAY_MODE '${mode}' is not one of openai, codex, ollama, passthrough`);
  }
  return {
    mode,
    target: env.LLM_GATEWAY_TARGET_URL || DEFAULT_TARGET[mode],
    raw: env.LLM_GATEWAY_PASSTHROUGH_RAW === "1",
    port: parseInt(env.LLM_GATEWAY_PORT || "11434", 10),
    codexAccountId: env.CODEX_ACCOUNT_ID || undefined,
  };
}

export function createServer(config: GatewayConfig): http.Server {
  const byok: ByokModeOptions | null = config.mode === "openai" || config.mode === "codex"
    ? { mode: config.mode, target: config.target, codexAccountId: config.codexAccountId }
    : null;
  return http.createServer((req, res) => {
    const run = byok
      ? handleByok(req, res, byok)
      : Promise.resolve(handlePassthrough(req, res, { target: config.target, raw: config.raw && config.mode === "passthrough" }));
    run.catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
    });
  });
}

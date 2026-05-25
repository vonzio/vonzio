import { z } from "zod";
import type { FastifyReply } from "fastify";
import { ErrorCodes } from "../errors.js";
import { TASK_MODES, TASK_PRIORITIES } from "@vonzio/shared";
import { PROFILE_PROVIDERS } from "@vonzio/shared";
import { MEMORY_TYPES } from "@vonzio/shared";
import { SLUG_PATTERN, SLUG_MAX_LENGTH } from "../services/slug.js";

export const submitTaskSchema = z.object({
  mode: z.enum(TASK_MODES).optional(),
  prompt: z.string().min(1, "prompt is required"),
  profile_id: z.string().min(1).optional(),
  session_id: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  output_schema: z.record(z.unknown()).optional(),
  workspace: z
    .object({
      type: z.enum(["git", "files"]),
      git_url: z.string().optional(),
      git_ref: z.string().optional(),
      git_pat: z.string().optional(),
      files: z
        .array(z.object({ path: z.string(), content: z.string() }))
        .optional(),
    })
    .optional(),
  claude_md: z.string().optional(),
  egress_domains: z.array(z.string()).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  timeout_seconds: z.number().int().positive().optional(),
  retry: z
    .object({
      max_attempts: z.number().int().positive().default(3),
      backoff_seconds: z.number().positive().default(5),
      retry_on: z.array(z.enum(["timeout", "error", "rate_limit"])).default(["timeout", "error", "rate_limit"]),
    })
    .optional(),
});

export const mcpServerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["sdk", "stdio", "http"]),
  tools: z.array(z.string()).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export const subagentSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
});

export const createProfileSchema = z.object({
  name: z.string().min(1, "name is required"),
  slug: z.string().regex(SLUG_PATTERN, "slug must be lowercase letters, digits, and hyphens").max(SLUG_MAX_LENGTH).optional(),
  api_key_id: z.string().optional(),
  default_tools: z.array(z.string()).optional(),
  default_egress_domains: z.array(z.string()).optional(),
  mcp_servers: z.array(mcpServerSchema).optional(),
  agent_ids: z.array(z.string()).optional(),
  skill_ids: z.array(z.string()).optional(),
  claude_md: z.string().optional(),
  git_provider_id: z.string().optional(),
  git_provider_ids: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  container_image: z.string().min(1).optional(),
  container_registry: z.object({
    url: z.string().min(1),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
  setup_commands: z.array(z.string().min(1)).max(50).optional(),
  persistent_sessions: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
  max_turns: z.number().int().min(1).max(10000).optional().nullable(),
  auto_continue: z.boolean().optional(),
  max_continuations: z.number().int().min(1).max(50).optional(),
  continuation_budget_usd: z.number().positive().optional().nullable(),
  concurrency_limit: z.number().int().positive().optional(),
});

export const updateProfileSchema = createProfileSchema.partial();

export const createMemorySchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(MEMORY_TYPES),
  body: z.string().min(1),
  description: z.string().max(200).optional(),
  profile_id: z.string().optional(),
});

export const updateMemorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  body: z.string().min(1).optional(),
  description: z.string().max(200).optional(),
});

export const searchMemorySchema = z.object({
  q: z.string().min(1),
  type: z.enum(MEMORY_TYPES).optional(),
  profile_id: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export type SubmitTaskBody = z.infer<typeof submitTaskSchema>;
export type CreateProfileBody = z.infer<typeof createProfileSchema>;
export type CreateMemoryBody = z.infer<typeof createMemorySchema>;
export type UpdateMemoryBody = z.infer<typeof updateMemorySchema>;
export type SearchMemoryQuery = z.infer<typeof searchMemorySchema>;

export function sendValidationError(reply: FastifyReply, error: z.ZodError): void {
  reply.code(400).send({
    error: "Validation failed",
    code: ErrorCodes.VALIDATION_FAILED,
    details: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

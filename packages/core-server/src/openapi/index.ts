/**
 * OpenAPI 3.0 specification for the Vonzio HTTP API.
 *
 * Two responsibilities, kept distinct:
 *
 *   1. `swaggerOptions` — top-level OpenAPI metadata (info, servers,
 *      tags, security schemes). Passed to `@fastify/swagger` at
 *      registration time.
 *
 *   2. `componentSchemas` + `registerSchemas(server)` — each named
 *      component is a separate Fastify schema, registered via
 *      `server.addSchema()` after the swagger plugin is installed.
 *      Routes reference them with `{ $ref: "<SchemaId>" }`.
 *
 * **Why two paths, not one.** Fastify's per-route validator compiler
 * and `@fastify/swagger`'s component collector are *separate
 * registries*. Schemas declared inside `swaggerOptions.openapi.components.schemas`
 * appear in the generated spec but Fastify can't resolve route
 * `$ref`s against them — you get `FST_ERR_SCH_VALIDATION_BUILD` at
 * boot and the server crashes.
 *
 * `server.addSchema()` puts the schema in *Fastify's* registry. The
 * swagger plugin then auto-collects every addSchema-registered schema
 * into the generated spec's `components.schemas` block. One source of
 * truth, refs work in both directions. (Verified by the boot smoke
 * test in `openapi.test.ts`.)
 */
import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";
import type { FastifySwaggerUiOptions } from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { WORKSPACE_STATUSES } from "@vonzio/shared";

/**
 * Ajv config Fastify needs to compile route schemas that include OpenAPI
 * annotation keywords (`example`, `examples`, `discriminator`, etc.).
 *
 * These keywords are valid OpenAPI 3 but NOT in standard JSON Schema.
 * Ajv's strict schema mode rejects them as unknown — fatal at boot.
 *
 * `strictSchema: false` treats them as no-op annotations. Validation
 * strictness on types and values is preserved.
 *
 * Re-exported so the boot smoke test mirrors buildServer's real Fastify
 * config (one source of truth, no drift).
 */
export const ajvOptions: FastifyServerOptions["ajv"] = {
  customOptions: {
    strictSchema: false,
  },
};

const INTRO_MARKDOWN = `
The Vonzio HTTP API lets you create and manage Claude agent profiles, store
per-agent secrets, schedule autonomous playbook runs, and inspect long-lived
workspaces. Everything you can do in the dashboard is reachable here.

## Authentication

All routes require a bearer token. Mint one in the dashboard:
**Settings → API tokens → Create token**, then pass it in the
\`Authorization\` header on every request:

\`\`\`
Authorization: Bearer rc_<your-token>
\`\`\`

The token bypasses interactive auth and acts on behalf of the user who
created it. Tokens never expire — rotate them in Settings if exposed.

## Conventions

- **Versioning**: every business endpoint sits under \`/v1/\`. Breaking
  changes get a new prefix; non-breaking additions land in-place.
- **Errors**: \`4xx\`/\`5xx\` responses return a structured body
  (\`{ error: { code, message } }\`) — see the \`Error\` component.
- **Timestamps**: ISO-8601 strings in UTC unless noted.
- **IDs**: UUIDs except for typed prefixes (\`prof_*\`, \`pb_*\`,
  \`sec_*\`, \`rc_*\`).

## Getting started

The fastest path from zero to a working agent:

1. \`POST /v1/api-keys\` — store an Anthropic API key (or link an Ollama
   endpoint).
2. \`POST /v1/profiles\` — create an agent profile referencing the key.
3. \`POST /v1/secrets\` — add any per-agent secrets the agent needs (DB
   URLs, third-party tokens). Scope them to the profile.
4. \`POST /v1/playbooks\` — optional: schedule the agent on a cron.
5. \`POST /v1/tasks\` — kick off a one-shot run, or chat with the
   profile in the dashboard.

Each section below documents the endpoints in detail.
`.trim();

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Vonzio API",
      description: INTRO_MARKDOWN,
      version: "1.0.0",
      contact: {
        name: "Vonzio",
        url: "https://vonz.io",
      },
    },
    servers: [
      { url: "https://app.vonz.io", description: "Production" },
      { url: "http://vonz.localhost", description: "Local dev" },
    ],
    tags: [
      { name: "Profiles", description: "Agent profile management" },
      { name: "Secrets", description: "Per-agent encrypted environment variables" },
      { name: "Playbooks", description: "Scheduled and autonomous agent runs" },
      { name: "Workspaces", description: "Long-running chat sessions backed by Docker containers" },
      { name: "Tasks", description: "One-shot agent runs" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Vonzio API token (prefix `rc_`). Create one in the dashboard under " +
            "Settings → API tokens.",
        },
      },
      // Note: schemas are NOT defined here. They live in `componentSchemas`
      // below and are registered via `server.addSchema()` so refs resolve
      // both for the generated spec AND for runtime route validation.
    },
    security: [{ bearerAuth: [] }],
  },
  // Use each schema's $id as its key in components.schemas instead of
  // the default `def-N` auto-numbering. Otherwise the UI shows
  // anonymous "def-0", "def-1" entries — useless for browsing.
  refResolver: {
    buildLocalReference: (json, _baseUri, _fragment, i) => {
      const id = (json as { $id?: string }).$id;
      return id ?? `def-${i}`;
    },
  },
};

export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: "/v1/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    persistAuthorization: true,
    tryItOutEnabled: true,
    tagsSorter: "alpha",
    operationsSorter: "alpha",
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
};

/**
 * Named component schemas. Each has a `$id` and lives in its own
 * Fastify schema registry entry after `registerSchemas()` runs.
 * Route handlers reference them with `{ $ref: "<Id>" }`.
 */
export const componentSchemas = {
  // ── Shared ──────────────────────────────────────────────────────
  Error: {
    $id: "Error",
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", example: "VALIDATION_FAILED" },
          message: { type: "string", example: "name is required" },
        },
      },
    },
  },

  // ── Profiles ────────────────────────────────────────────────────
  Profile: {
    $id: "Profile",
    type: "object",
    required: ["id", "name", "slug", "provider", "created_at", "updated_at"],
    additionalProperties: true,
    properties: {
      id: { type: "string", example: "prof_4XgS61A_vp7lfWXopdIMV" },
      user_id: {
        type: "string",
        nullable: true,
        description: "Owning user. `null` for shared/system profiles visible to everyone.",
      },
      name: { type: "string", example: "VZFinance" },
      slug: {
        type: "string",
        description: "URL- and mention-safe identifier (`@vzfinance` in Slack).",
        example: "vzfinance",
      },
      provider: {
        type: "string",
        enum: ["api_key", "ollama"],
        description: "How the agent talks to the model.",
      },
      api_key_id: { type: "string", nullable: true },
      model: {
        type: "string",
        nullable: true,
        description: "Family alias resolved at runtime: `sonnet` / `opus` / `haiku`, or empty for default.",
        example: "opus",
      },
      effort: { type: "string", enum: ["low", "medium", "high", "max"], nullable: true },
      claude_md: { type: "string", nullable: true, description: "Agent system prompt." },
      default_tools: { type: "array", items: { type: "string" } },
      default_egress_domains: { type: "array", items: { type: "string" } },
      mcp_servers: { type: "array", items: { type: "object", additionalProperties: true } },
      agent_ids: { type: "array", items: { type: "string" } },
      skill_ids: { type: "array", items: { type: "string" } },
      git_provider_ids: { type: "array", items: { type: "string" } },
      persistent_sessions: { type: "boolean" },
      memory_enabled: { type: "boolean" },
      max_turns: { type: "integer", nullable: true, minimum: 1 },
      auto_continue: { type: "boolean" },
      max_continuations: { type: "integer", minimum: 1, maximum: 200 },
      continuation_budget_usd: { type: "number", nullable: true, minimum: 0 },
      concurrency_limit: { type: "integer", minimum: 1 },
      setup_commands: { type: "array", items: { type: "string" } },
      container_image: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      last_used_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  CreateProfileInput: {
    $id: "CreateProfileInput",
    type: "object",
    required: ["name"],
    additionalProperties: true,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
      slug: { type: "string" },
      provider: { type: "string", enum: ["api_key", "ollama"], default: "api_key" },
      api_key_id: { type: "string", nullable: true },
      model: { type: "string", nullable: true },
      effort: { type: "string", enum: ["low", "medium", "high", "max"], nullable: true },
      claude_md: { type: "string", nullable: true },
      default_tools: { type: "array", items: { type: "string" } },
      default_egress_domains: { type: "array", items: { type: "string" } },
      persistent_sessions: { type: "boolean" },
      memory_enabled: { type: "boolean" },
      max_turns: { type: "integer", nullable: true, minimum: 1 },
      auto_continue: { type: "boolean" },
      max_continuations: { type: "integer", minimum: 1, maximum: 200 },
      continuation_budget_usd: { type: "number", nullable: true, minimum: 0 },
      concurrency_limit: { type: "integer", minimum: 1 },
      setup_commands: { type: "array", items: { type: "string" } },
    },
  },
  UpdateProfileInput: {
    $id: "UpdateProfileInput",
    type: "object",
    description: "All fields optional — only provided fields are updated.",
    additionalProperties: true,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
      slug: { type: "string" },
      api_key_id: { type: "string", nullable: true },
      model: { type: "string", nullable: true },
      effort: { type: "string", enum: ["low", "medium", "high", "max"], nullable: true },
      claude_md: { type: "string", nullable: true },
      default_tools: { type: "array", items: { type: "string" } },
      default_egress_domains: { type: "array", items: { type: "string" } },
      persistent_sessions: { type: "boolean" },
      memory_enabled: { type: "boolean" },
      max_turns: { type: "integer", nullable: true, minimum: 1 },
      auto_continue: { type: "boolean" },
      max_continuations: { type: "integer", minimum: 1, maximum: 200 },
      continuation_budget_usd: { type: "number", nullable: true, minimum: 0 },
      concurrency_limit: { type: "integer", minimum: 1 },
      setup_commands: { type: "array", items: { type: "string" } },
    },
  },

  // ── Secrets ─────────────────────────────────────────────────────
  Secret: {
    $id: "Secret",
    type: "object",
    required: ["id", "user_id", "name", "value", "scope", "profile_ids", "created_at", "updated_at"],
    additionalProperties: true,
    properties: {
      id: { type: "string", example: "sec_xQ8...e0" },
      user_id: { type: "string" },
      name: { type: "string", description: "Env-var-shaped: `^[A-Z_][A-Z0-9_]*$`.", example: "DATABASE_URL" },
      value: { type: "string", description: "Always redacted to `••••••••` over the API.", example: "••••••••" },
      scope: { type: "string", enum: ["all", "agents"] },
      profile_ids: { type: "array", items: { type: "string" } },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  CreateSecretInput: {
    $id: "CreateSecretInput",
    type: "object",
    required: ["name", "value"],
    additionalProperties: true,
    properties: {
      name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
      value: { type: "string" },
      scope: { type: "string", enum: ["all", "agents"], default: "all" },
      profile_ids: { type: "array", items: { type: "string" } },
    },
  },
  UpdateSecretInput: {
    $id: "UpdateSecretInput",
    type: "object",
    additionalProperties: true,
    properties: {
      name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
      value: { type: "string" },
      scope: { type: "string", enum: ["all", "agents"] },
      profile_ids: { type: "array", items: { type: "string" } },
    },
  },

  // ── Playbooks ───────────────────────────────────────────────────
  PlaybookChainConfig: {
    $id: "PlaybookChainConfig",
    type: "object",
    required: ["max_chains", "budget_cap_usd", "chain_delay_ms"],
    additionalProperties: true,
    properties: {
      max_chains: { type: "integer", minimum: 1, maximum: 20 },
      budget_cap_usd: { type: "number", minimum: 0.1, maximum: 100 },
      chain_delay_ms: { type: "integer", minimum: 1000, maximum: 60000 },
      max_turns_per_chain: { type: "integer", minimum: 5, maximum: 200 },
      allowed_tools: { type: "array", items: { type: "string" } },
      timeout_per_chain_seconds: { type: "integer", minimum: 60 },
    },
  },
  Playbook: {
    $id: "Playbook",
    type: "object",
    required: ["id", "user_id", "profile_id", "name", "prompt", "schedule", "chain_config", "enabled", "notify_on", "trigger_type", "created_at", "updated_at"],
    additionalProperties: true,
    properties: {
      id: { type: "string", example: "pb_Hg0Q2OvYGi7SiBZ7usVVJ" },
      user_id: { type: "string" },
      profile_id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      prompt: { type: "string" },
      schedule: { type: "string", example: "0 23 * * *" },
      chain_config: { $ref: "PlaybookChainConfig" },
      enabled: { type: "boolean" },
      notify_on: { type: "string", enum: ["completion", "failure", "both", "none"] },
      notification_channels: { type: "array", items: { type: "string" } },
      trigger_type: { type: "string", enum: ["cron", "interval", "manual", "webhook"] },
      interval_seconds: { type: "integer", nullable: true, minimum: 60 },
      webhook_token: { type: "string", nullable: true },
      success_criteria: { type: "array", items: { type: "object", additionalProperties: true }, nullable: true },
      last_run_at: { type: "string", format: "date-time", nullable: true },
      next_run_at: { type: "string", format: "date-time", nullable: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  CreatePlaybookInput: {
    $id: "CreatePlaybookInput",
    type: "object",
    required: ["name", "profile_id", "prompt", "schedule"],
    additionalProperties: true,
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      profile_id: { type: "string" },
      prompt: { type: "string" },
      schedule: { type: "string" },
      chain_config: { $ref: "PlaybookChainConfig" },
      enabled: { type: "boolean", default: false },
      trigger_type: { type: "string", enum: ["cron", "interval", "manual", "webhook"], default: "cron" },
      interval_seconds: { type: "integer", minimum: 60 },
      notify_on: { type: "string", enum: ["completion", "failure", "both", "none"], default: "none" },
      notification_channels: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "object", additionalProperties: true } },
    },
  },
  PlaybookRun: {
    $id: "PlaybookRun",
    type: "object",
    required: ["id", "playbook_id", "status", "started_at"],
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      playbook_id: { type: "string" },
      status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled"] },
      decision: { type: "string", nullable: true, enum: ["pass", "fail", "skipped"] },
      chains_used: { type: "integer" },
      turns_used: { type: "integer" },
      cost_usd: { type: "number" },
      started_at: { type: "string", format: "date-time" },
      finished_at: { type: "string", format: "date-time", nullable: true },
      error: { type: "string", nullable: true },
      result_summary: { type: "string", nullable: true },
    },
  },

  // ── Workspaces ──────────────────────────────────────────────────
  Workspace: {
    $id: "Workspace",
    type: "object",
    required: ["session_id", "profile_id", "status", "created_at"],
    additionalProperties: true,
    properties: {
      session_id: { type: "string" },
      profile_id: { type: "string" },
      name: { type: "string", nullable: true },
      status: {
        type: "string",
        // Imported from the same `WORKSPACE_STATUSES` constant the type
        // system uses (types/workspace.ts). Don't inline a literal here —
        // we did that once, it drifted, and the OpenAPI spec advertised
        // statuses that don't exist while omitting `expired` which is the
        // actual terminal state. Spreading the constant makes drift
        // impossible at compile time.
        enum: [...WORKSPACE_STATUSES],
      },
      container_status: { type: "string", nullable: true },
      container_id: { type: "string", nullable: true },
      last_active_at: { type: "string", format: "date-time" },
      last_run_model: { type: "string", nullable: true },
      model_override: { type: "string", nullable: true },
      starred: { type: "boolean" },
      archived: { type: "boolean" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  WorkspaceEvent: {
    $id: "WorkspaceEvent",
    type: "object",
    required: ["seq", "type", "created_at"],
    additionalProperties: true,
    properties: {
      seq: { type: "integer" },
      type: { type: "string" },
      payload: { type: "object", additionalProperties: true },
      created_at: { type: "string", format: "date-time" },
    },
  },

  // ── Tasks ───────────────────────────────────────────────────────
  Task: {
    $id: "Task",
    type: "object",
    required: ["id", "status", "mode", "profile_id", "prompt", "created_at"],
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      mode: { type: "string", enum: ["batch", "session", "stream"] },
      status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled"] },
      profile_id: { type: "string" },
      session_id: { type: "string", nullable: true },
      prompt: { type: "string" },
      model: { type: "string", nullable: true },
      allowed_tools: { type: "array", items: { type: "string" }, nullable: true },
      max_turns: { type: "integer", nullable: true },
      max_budget_usd: { type: "number", nullable: true },
      result: { type: "object", nullable: true, additionalProperties: true },
      error: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      started_at: { type: "string", format: "date-time", nullable: true },
      finished_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  SubmitTaskInput: {
    $id: "SubmitTaskInput",
    type: "object",
    required: ["profile_id", "prompt"],
    additionalProperties: true,
    properties: {
      profile_id: { type: "string" },
      prompt: { type: "string" },
      mode: { type: "string", enum: ["batch", "session", "stream"], default: "batch" },
      session_id: { type: "string" },
      model: { type: "string" },
      allowed_tools: { type: "array", items: { type: "string" } },
      max_turns: { type: "integer", minimum: 1 },
      max_budget_usd: { type: "number", minimum: 0 },
      effort: { type: "string", enum: ["low", "medium", "high", "max"] },
      output_schema: { type: "object", additionalProperties: true },
    },
  },
} as const;

/**
 * Register every component schema with the Fastify instance so route
 * `$ref` blocks resolve at validator-compile time AND
 * `@fastify/swagger` collects them into the spec's components section.
 *
 * Must be called **after** `server.register(swagger, swaggerOptions)`
 * so the swagger plugin sees them when it builds the spec.
 */
export function registerSchemas(server: FastifyInstance): void {
  for (const schema of Object.values(componentSchemas)) {
    server.addSchema(schema);
  }
}

/**
 * Exposes the OpenAPI 3 spec as JSON at `/v1/openapi.json`.
 *
 * The same content is also reachable at `/v1/docs/json` (auto-mounted by
 * `@fastify/swagger-ui` under its `routePrefix`). External clients —
 * codegen tools, IDE plugins, link unfurls — overwhelmingly expect the
 * `openapi.json` convention, so we expose both. `hide: true` keeps this
 * route out of the spec itself (we don't need to document the route
 * that returns the docs).
 *
 * Must be called **after** `server.register(swagger, ...)` so the
 * `swagger()` decorator exists on the instance.
 *
 * Must be called **outside** any auth-scoped plugin: the docs UI is
 * unauthenticated and the JSON spec needs to match that posture so
 * codegen and link previews work without a token.
 */
export function registerOpenApiJsonRoute(server: FastifyInstance): void {
  const withSwagger = server as FastifyInstance & { swagger: () => unknown };
  server.get("/v1/openapi.json", { schema: { hide: true } }, async () => {
    return withSwagger.swagger();
  });
}

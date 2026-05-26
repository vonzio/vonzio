import { z } from "zod";

const configSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Encryption
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters"),

  // Auth (Better Auth)
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  // Default OFF so OSS self-hosters get a locked-down single-user instance
  // out of the box. SaaS deploys set this explicitly via compose/env.
  // Accept the common false-ish env strings so REGISTRATION_ENABLED=0 (or
  // no/off/empty) genuinely keeps registration off — the previous
  // `v !== "false"` test treated those as truthy and silently opened
  // multi-tenant signup for operators who used non-canonical values.
  REGISTRATION_ENABLED: z.string().transform((v) => {
    const lower = v.trim().toLowerCase();
    return !["false", "0", "no", "off", ""].includes(lower);
  }).default("false"),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Vonzio <noreply@app.vonz.io>"),

  // Platform-hosted Telegram bot — optional. When set, users can pair
  // their account with a single shared bot (one tap) instead of running
  // their own via BotFather. Webhook secret protects the shared endpoint.
  PLATFORM_TELEGRAM_BOT_TOKEN: z.string().optional(),
  PLATFORM_TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Database
  DATABASE_URL: z.string().default("postgres://vonzio:vonzio_dev@localhost:5432/vonzio"),

  // Tools
  TOOLS_DIR: z.string().default("/app/tools"),
  SKILLS_DIR: z.string().default("/app/skills"),

  // Event log (session replay)
  EVENT_LOG_DIR: z.string().default("./data/events"),

  // Preview proxy
  PREVIEW_MODE: z.enum(["path", "hostname"]).default("path"),
  PREVIEW_DOMAIN: z.string().default("vonzio.localhost"),
  PREVIEW_URL_TEMPLATE: z.string().default("http://localhost:3000/preview/{container_id}/{port}/"),

  // Docker
  DOCKER_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DOCKER_NETWORK: z.string().optional(),
  AGENT_IMAGE: z.string().default("vonzio-agent:latest"),

  // Batch + pooled concurrency
  MAX_CONCURRENT_AGENTS: z.coerce.number().default(4),
  TASK_TIMEOUT_SECONDS: z.coerce.number().default(300),
  MAX_TURNS: z.coerce.number().default(200),

  // Pool (Mode B)
  POOL_MIN_SIZE: z.coerce.number().default(3),
  POOL_MAX_SIZE: z.coerce.number().default(10),
  POOL_IDLE_DRAIN_SECS: z.coerce.number().default(60),
  POOL_MAX_RECYCLES: z.coerce.number().default(50),
  POOL_HEALTH_CHECK_INTERVAL_SECS: z.coerce.number().default(30),

  // Session (Mode C)
  SESSION_IDLE_TTL_SECS: z.coerce.number().default(14400),
  SESSION_MAX_LIFETIME_SECS: z.coerce.number().default(86400),
  MAX_SESSION_CONTAINERS: z.coerce.number().default(50),

  // Workstation persistent sessions
  WORKSTATION_IDLE_PAUSE_SECS: z.coerce.number().default(86400),
  WORKSTATION_MAX_PAUSED: z.coerce.number().default(10),
  WORKSTATION_VOLUME_TTL_DAYS: z.coerce.number().default(30),
  WORKSTATION_MAX_LIFETIME_SECS: z.coerce.number().default(604800),

  // Rate limiting
  RATE_LIMIT_CALLER_RPM: z.coerce.number().default(60),
  RATE_LIMIT_CALLER_BURST: z.coerce.number().default(10),
  RATE_LIMIT_PROFILE_CONCURRENCY: z.coerce.number().default(5),

  // Container resources
  CONTAINER_CPU_LIMIT_BATCH: z.coerce.number().default(1),
  CONTAINER_CPU_LIMIT_SESSION: z.coerce.number().default(0.5),
  CONTAINER_MEMORY_LIMIT_BATCH: z
    .string()
    .regex(/^\d+[bkmg]$/i, "Must be a Docker memory value (e.g. 512m, 1g)")
    .default("1g"),
  CONTAINER_MEMORY_LIMIT_SESSION: z
    .string()
    .regex(/^\d+[bkmg]$/i, "Must be a Docker memory value (e.g. 512m, 1g)")
    .default("768m"),

  // WebSocket
  WS_MAX_CONNECTIONS_PER_CALLER: z.coerce.number().default(10),

  // Slack Integration (optional — enables "Connect Slack" button)
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // Gmail Integration (optional — enables "Connect Gmail" button)
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),

  // Git OAuth (optional — enables "Connect with GitHub/GitLab/Bitbucket" buttons)
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),

  // Auth OAuth providers (for login, separate from git integration)
  AUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  BITBUCKET_CLIENT_ID: z.string().optional(),
  BITBUCKET_CLIENT_SECRET: z.string().optional(),

  // Marketing site URL (for footer Privacy/Terms links from in-product pages)
  MARKETING_URL: z.string().optional(),

  // Cloudflare Turnstile (captcha)
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Internal server URL (for MCP callbacks from agent containers)
  INTERNAL_SERVER_URL: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().default("*"),

  // Metrics
  PROMETHEUS_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  METRICS_FLUSH_INTERVAL_SECS: z.coerce.number().default(60),
  METRICS_RETENTION_DAYS: z.coerce.number().default(7),
  OLLAMA_ENABLED: z.string().transform((v) => v === "true").default("false"),

  // Teller (optional) — mTLS client cert + key for the Teller API.
  // Cert + key are bind-mounted into /run/secrets/teller in dev/prod
  // compose; APP_ID is the cert's CN. All five optional so the server
  // boots fine without Teller wired.
  TELLER_APP_ID: z.string().optional(),
  TELLER_CERT_PATH: z.string().optional(),
  TELLER_KEY_PATH: z.string().optional(),
  // .url() so a typo (e.g. "htps://api.teller.io") fails fast at boot
  // instead of at first API call.
  TELLER_API_BASE: z.string().url().default("https://api.teller.io"),
  // Ed25519 PUBLIC key (base64) that Teller uses to sign enrollment
  // JWTs returned by Teller Connect. Used at the Connect callback to
  // verify the token wasn't forged by a malicious frontend. Not secret
  // by design — env var only so a Teller-side rotation is config, not
  // code.
  TELLER_SIGNING_PUBKEY: z.string().optional(),
  // Which Teller Connect environment the dashboard should open:
  //   sandbox     — fake test institutions, no real bank linkage
  //   development — real banks, free-tier Developer limits (100 connections)
  //   production  — real banks, per-call billing
  // Defaults to sandbox so a misconfigured deploy can't accidentally pull
  // real account data. Set to "development" to link real personal banks
  // on the free tier.
  TELLER_ENVIRONMENT: z.enum(["sandbox", "development", "production"]).default("sandbox"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }
  return result.data;
}

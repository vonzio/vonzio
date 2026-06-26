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
  EMAIL_FROM: z.string().default("vonzio <noreply@app.vonz.io>"),

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
  // Writable store for uploaded skill bundles (zip archives). Defaults under the
  // existing persistent data volume (vonzio-data:/app/data) so no extra mount is
  // needed. Distinct from the read-only built-in catalog (SKILLS_DIR).
  SKILLS_DATA_DIR: z.string().default("/app/data/skills"),

  // Event log (session replay)
  EVENT_LOG_DIR: z.string().default("./data/events"),

  // Embeddable chat widget. CSV of external origins allowed to embed the
  // `/chat` surface (sets CSP `frame-ancestors`). Empty (default) = same-origin
  // only ('self'): the widget works on the vonzio origin's own pages out of the
  // box; embedding on a DIFFERENT site requires listing that site's origin
  // here, e.g. WIDGET_ALLOWED_ORIGINS=https://acme.com,https://docs.acme.com.
  WIDGET_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      // Keep only well-formed origins, normalized to scheme://host[:port]. A
      // malformed entry (no scheme, a path, stray text) injected into the CSP
      // `frame-ancestors` directive would break the whole header (the browser
      // drops it), silently disabling the gate — so drop bad entries here.
      Array.from(
        new Set(
          v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              try { return new URL(s).origin; } catch { return null; }
            })
            .filter((s): s is string => s !== null),
        ),
      ),
    ),

  // Preview proxy
  PREVIEW_MODE: z.enum(["path", "hostname"]).default("path"),
  PREVIEW_DOMAIN: z.string().default("vonzio.localhost"),
  PREVIEW_URL_TEMPLATE: z.string().default("http://localhost:3000/preview/{container_id}/{port}/"),

  // Docker
  DOCKER_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  // Preferred — Docker-CLI-compatible URL. Takes precedence over DOCKER_SOCKET
  // when set. Used in the default compose stack to point at docker-socket-proxy
  // (DOCKER_HOST=tcp://docker-proxy:2375) so core-server no longer holds the
  // raw daemon socket. Accepted forms:
  //   unix:///var/run/docker.sock
  //   tcp://host:2375
  DOCKER_HOST: z.string().optional(),
  // Legacy fallback. Unused when DOCKER_HOST is set.
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DOCKER_NETWORK: z.string().optional(),
  AGENT_IMAGE: z.string().default("vonzio-agent:latest"),

  // Egress enforcement (feature 0005). When on, agent containers run on an
  // internal (no-direct-internet) docker network and reach the outside world
  // ONLY through a shared egress proxy that permits the model endpoint + the
  // profile/task egress allowlist; everything else is refused at the network
  // layer. Default OFF: OSS self-hosters keep today's advisory behavior so an
  // upgrade doesn't suddenly cut agents' internet; SaaS sets EGRESS_ENFORCEMENT=1.
  EGRESS_ENFORCEMENT: z.string().transform((v) => {
    const lower = v.trim().toLowerCase();
    return !["false", "0", "no", "off", ""].includes(lower);
  }).default("false"),
  EGRESS_PROXY_IMAGE: z.string().default("vonzio-egress-proxy:latest"),
  // The internal docker network agents are placed on under enforcement.
  EGRESS_PROXY_NETWORK: z.string().default("vonzio-egress"),
  // HMAC secret the proxy uses to verify per-agent allowlist tokens. Falls back
  // to ENCRYPTION_KEY when unset so there's always a strong secret.
  EGRESS_PROXY_SECRET: z.string().optional(),

  // Plugins
  // Comma-separated list of plugin packages to load at boot, e.g.
  // "@vonzio/plugin-telegram,@vonzio/plugin-slack@^0.1". Loader strips
  // the @version-constraint suffix -- whatever the package resolver
  // installed at npm-install / image-build time is what runs. Empty /
  // unset = no plugins. See packages/core-server/src/plugins/loader.ts.
  VONZIO_PLUGINS: z.string().optional(),

  // Batch + pooled concurrency
  MAX_CONCURRENT_AGENTS: z.coerce.number().default(4),
  // Per-TURN watchdog (reset each goal-loop round), not a whole-loop cap. Only
  // meant to catch a genuinely hung turn (model never responds / tool deadlock)
  // so it can't hold a container + slot forever. 300s cut legitimate heavy
  // turns (deps + tests + build in one turn); 1800s only trips on a real hang.
  // 0 disables the watchdog entirely.
  TASK_TIMEOUT_SECONDS: z.coerce.number().default(1800),
  MAX_TURNS: z.coerce.number().default(200),

  // Per-agent knowledge documents (mounted at /knowledge). Stored base64 in
  // Postgres, so keep these sane for your DB. Per-file cap and per-profile
  // total cap, both in megabytes.
  MAX_DOCUMENT_MB: z.coerce.number().default(100),
  MAX_PROFILE_DOCUMENTS_MB: z.coerce.number().default(500),

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
    // 2g: session agents routinely install deps + run a test suite (+ sometimes
    // chromium); 768m OOM-killed the container mid-run, which surfaced as the
    // goal judge's "container not running" (409). Raise the floor.
    .default("2g"),
  // Max processes/threads per container (fork-bomb / PID-exhaustion guard).
  // 0 disables the limit.
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().min(0).default(512),

  // WebSocket
  WS_MAX_CONNECTIONS_PER_CALLER: z.coerce.number().default(10),

  // Cross-subdomain cookie sharing for the Better Auth session cookie.
  // Set to `.example.com` to share between app.example.com and admin.example.com.
  // Unset = host-only cookie (default).
  COOKIE_DOMAIN: z.string().optional(),

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

  // GitHub App (optional — enables the "Install GitHub App" flow). Unlike the
  // OAuth App above, a GitHub App is installed per account/org with per-repo
  // selection and is approved by an org owner as part of the install — it
  // sidesteps "OAuth App access restrictions" entirely and mints short-lived,
  // least-privilege installation tokens. GITHUB_APP_SLUG is the app's URL slug
  // (github.com/apps/<slug>); GITHUB_APP_PRIVATE_KEY is the PEM (literal "\n"
  // escapes are normalized to newlines at load).
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  // The PEM private key. Prefer GITHUB_APP_PRIVATE_KEY_PATH for Docker: compose
  // `env_file` is line-based and mangles a multi-line PEM (and inlining one with
  // literal "\n" escapes is brittle), so mount the .pem as a file secret and
  // point this path at it — mirrors the Teller mTLS file-secret pattern.
  // GITHUB_APP_PRIVATE_KEY (inline) stays supported for host-mode / non-Docker.
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  // The App's user-OAuth client id + secret. REQUIRED for the install flow:
  // they let the callback verify (via the user-OAuth `code` GitHub returns) that
  // the person actually owns the installation they sent us — otherwise an
  // enumerable installation_id could be bound to the wrong account. Enable
  // "Request user authorization (OAuth) during installation" on the App too.
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

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

  // Teller config moved to the external @vonzio/plugin-teller plugin (its own
  // TELLER_* env schema + mtls_secrets policy entry). Core no longer reads it.
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

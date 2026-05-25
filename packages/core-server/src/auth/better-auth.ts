import { betterAuth } from "better-auth";
import { admin, captcha } from "better-auth/plugins";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { Resend } from "resend";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { Config } from "../config.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { emailLayout } from "../email/templates.js";
import type { Tracker } from "../lib/event-tracker/index.js";

function resolveLoginMethod(context: { path?: string } | null | undefined): string | null {
  const path = context?.path;
  if (!path) return null;
  if (path.startsWith("/callback/") || path.startsWith("/oauth2/callback/")) {
    return path.split("/").filter(Boolean).pop() ?? null;
  }
  if (path === "/sign-in/email") return "email";
  if (path === "/sign-up/email") return "email";
  if (path.startsWith("/magic-link/verify")) return "magic-link";
  if (path.includes("/passkey/verify-authentication")) return "passkey";
  return null;
}

// Return type is `any` because Better Auth's full betterAuth() return
// references zod types in its own nested node_modules path, which TS
// can't name portably (TS2742). The inferred shape is still correct at
// every call site that doesn't try to re-export it; consumers use the
// `Auth` alias below (ReturnType<typeof createAuth>) which preserves
// inference without needing the unportable zod path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuth(config: Config, pool: pg.Pool, db: DrizzleDB, tracker?: Tracker): any {
  const resend = config.RESEND_API_KEY ? new Resend(config.RESEND_API_KEY) : null;

  const auth = betterAuth({
    database: pool,
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    socialProviders: {
      ...(config.AUTH_GOOGLE_CLIENT_ID && config.AUTH_GOOGLE_CLIENT_SECRET ? {
        google: {
          clientId: config.AUTH_GOOGLE_CLIENT_ID,
          clientSecret: config.AUTH_GOOGLE_CLIENT_SECRET,
        },
      } : {}),
      ...(config.AUTH_GITHUB_CLIENT_ID && config.AUTH_GITHUB_CLIENT_SECRET ? {
        github: {
          clientId: config.AUTH_GITHUB_CLIENT_ID,
          clientSecret: config.AUTH_GITHUB_CLIENT_SECRET,
        },
      } : {}),
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github"],
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.REGISTRATION_ENABLED,
      sendResetPassword: resend ? async ({ user, url }) => {
        await resend.emails.send({
          from: config.EMAIL_FROM,
          to: user.email,
          subject: "Reset your Vonzio password",
          html: emailLayout({
            name: user.name,
            body: "We received a request to reset your password. Click the button below to choose a new one.",
            cta: { label: "Reset Password", url },
            footer: "If you didn't request this, you can safely ignore this email.",
          }),
        });
      } : undefined,
    },
    emailVerification: resend ? {
      sendVerificationEmail: async ({ user, url }) => {
        await resend.emails.send({
          from: config.EMAIL_FROM,
          to: user.email,
          subject: "Verify your Vonzio email",
          html: emailLayout({
            name: user.name,
            body: "Please verify your email address to complete your account setup.",
            cta: { label: "Verify Email", url },
          }),
        });
      },
      sendOnSignUp: false,
    } : undefined,
    user: {
      additionalFields: {
        role: {
          type: "string",
          defaultValue: "user",
        },
        feature_flags: {
          type: "string",
          defaultValue: "",
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Block OAuth sign-up when registration is disabled
            if (!config.REGISTRATION_ENABLED) {
              const existing = await db.execute(sql`SELECT id FROM "user" WHERE email = ${user.email}`);
              if (existing.rows.length === 0) {
                return false; // block new user creation
              }
            }
            return undefined; // allow
          },
          after: async (user, context) => {
            // First registered user becomes admin
            const countResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM "user"`);
            const count = Number((countResult.rows[0] as { cnt: string | number })?.cnt ?? 0);
            if (count === 1) {
              await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE id = ${user.id}`);
            }

            // Clone a profile for the new user: prefer shared (user_id IS NULL), fall back to any profile
            try {
              const sharedProfiles = await db.select().from(schema.profiles).where(sql`${schema.profiles.user_id} IS NULL`).limit(1);
              const template = sharedProfiles[0] ?? (await db.select().from(schema.profiles).limit(1))[0];
              if (template) {
                const id = `prof_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
                await db.insert(schema.profiles).values({
                  id,
                  user_id: user.id,
                  name: "default",
                  slug: "default",
                  provider: template.provider ?? "api_key",
                  api_key_id: null,
                  default_tools: template.default_tools ?? [],
                  default_egress_domains: template.default_egress_domains ?? [],
                  mcp_servers: template.mcp_servers ?? [],
                  agent_ids: template.agent_ids ?? [],
                  skill_ids: template.skill_ids ?? [],
                  claude_md: template.claude_md,
                  model: template.model,
                  effort: template.effort,
                  setup_commands: template.setup_commands ?? [],
                  persistent_sessions: template.persistent_sessions ?? false,
                  concurrency_limit: template.concurrency_limit ?? 5,
                  created_at: new Date().toISOString(),
                });
              }
            } catch { /* template clone failed — user can create profiles manually */ }

            tracker?.track({
              event: "user.signed_up",
              source: "server",
              userId: user.id,
              properties: { email: user.email, method: resolveLoginMethod(context) },
            });
          },
        },
      },
      session: {
        create: {
          after: async (session, context) => {
            tracker?.track({
              event: "user.logged_in",
              source: "server",
              userId: session.userId,
              sessionId: session.id,
              properties: {
                method: resolveLoginMethod(context),
                ...(session.ipAddress ? { ip: session.ipAddress } : {}),
              },
            });
          },
        },
      },
    },
    plugins: [
      admin(),
      ...(config.TURNSTILE_SECRET_KEY ? [captcha({
        provider: "cloudflare-turnstile",
        secretKey: config.TURNSTILE_SECRET_KEY,
      })] : []),
    ],
    trustedOrigins: config.CORS_ORIGIN === "*"
      ? [
          // App surface (dev)
          "http://vonz.localhost",
          // Vite dev server direct (when bypassing Traefik)
          "http://localhost:5173",
          // Marketing site — for any cross-origin posts (waitlist, contact)
          "http://vonzio.localhost",
          // Whatever BETTER_AUTH_URL points at (e.g. ngrok tunnel for OAuth tests)
          config.BETTER_AUTH_URL,
        ]
      : config.CORS_ORIGIN.split(",").map((o) => o.trim()),
  });

  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Register Better Auth's catch-all route on a Fastify instance.
 */
export function mountBetterAuth(server: FastifyInstance, auth: Auth): void {
  // Intercept Better Auth error page — redirect to login with friendly message
  server.get("/api/auth/error", async (request: FastifyRequest, reply: FastifyReply) => {
    const errorCode = (request.query as Record<string, string>).error ?? "unknown";
    const messages: Record<string, string> = {
      unable_to_create_user: "Registration is currently disabled. Contact an admin for an invite.",
      oauth_account_already_linked: "This account is already linked to another user.",
    };
    const message = messages[errorCode] ?? "Authentication failed. Please try again.";
    return reply.redirect(`/?auth_error=${encodeURIComponent(message)}`);
  });

  server.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request: FastifyRequest, reply: FastifyReply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const body = request.method === "POST" && request.body
        ? JSON.stringify(request.body)
        : undefined;

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body,
      });

      const response = await auth.handler(req);

      reply.status(response.status);

      // Forward non-Set-Cookie headers as-is. We handle Set-Cookie separately
      // below because Fetch's `Headers.forEach` exposes Set-Cookie as a
      // single comma-joined string, which breaks cookies whose `Expires`
      // attribute contains commas (e.g. "Thu, 01 Jan 1970 …"). Use
      // `getSetCookie()` instead to get individual cookie strings.
      response.headers.forEach((value: string, key: string) => {
        if (key.toLowerCase() === "set-cookie") return;
        reply.header(key, value);
      });

      // Forward each Set-Cookie individually, and — when the cookie being
      // set is Better Auth's session token — mirror it into a non-secret
      // presence flag (`vonzio_authed`) that the marketing site can use to
      // detect login. The real session cookie is HttpOnly + SameSite=Lax,
      // so it's invisible to fetches from vonzio.com (a different eTLD).
      // The indicator is SameSite=None; Secure so it IS sent on cross-site
      // requests, but carries no auth value — only a presence marker (`1`).
      //
      // Note on staleness: the indicator's Max-Age is independent of the
      // real session TTL. If the real session is revoked early (admin
      // disable, password change), the indicator persists until its own
      // Max-Age expires or the user logs out through this handler. Worst
      // case: marketing shows "Open the app" → click → login redirect.
      // Acceptable degraded UX; bounded by Max-Age.
      //
      // Some browsers in strict third-party-cookie mode (Safari ITP, future
      // Chrome) may suppress this on cross-site fetches; in those cases the
      // hint endpoint returns `authed:false` and the landing falls back to
      // the default "Sign in" button. No regression for unsupported clients.
      const setCookies = response.headers.getSetCookie?.() ?? [];
      for (const cookie of setCookies) {
        reply.header("set-cookie", cookie);
        // In production (HTTPS), Better Auth prefixes the session cookie with
        // `__Secure-`. Match both prefixed and unprefixed forms so the mirror
        // gets set under either configuration.
        if (!/^(?:__Secure-)?better-auth\.session_token=/.test(cookie)) continue;
        const isClearing = /max-age=0|expires=thu, 01 jan 1970/i.test(cookie);
        reply.header(
          "set-cookie",
          isClearing
            ? "vonzio_authed=; Path=/; Max-Age=0; SameSite=None; Secure; HttpOnly"
            : "vonzio_authed=1; Path=/; Max-Age=604800; SameSite=None; Secure; HttpOnly",
        );
      }

      const text = await response.text();
      reply.send(text || null);
    },
  });
}

/**
 * The bridge between a stored vonzio credential and `@amenophis1er/byok/core`.
 *
 * byok owns the provider protocols (Anthropic Messages, OpenAI Chat
 * Completions / Responses, Gemini, the Codex catalog, Ollama signing). vonzio
 * owns storage, sign-in flows and the UI. This module is the one place that
 * maps an `api_keys` row — `{ provider, api_key, base_url }` — to a byok
 * connection plus credential, so listing, validation, the server-side judge
 * and auto-titles all route the same way. Nothing else in core-server should
 * build provider URLs or auth headers by hand.
 *
 * The in-container gateway (packages/llm-gateway) runs on the same byok core
 * and reads its connection from the env the orchestrator builds; the API root
 * for an OpenAI-compatible key comes from `connectionFor` here as well.
 */
import { chat, listModels, type ChatOptions, type ChatRequest, type Connection } from "@amenophis1er/byok/core";
import type { ProfileProvider } from "@vonzio/shared";
import { OLLAMA_BASE_URL } from "./ollama-service.js";
import { accountIdFromJwt } from "./codex-oauth-service.js";
import { normalizeOpenAIBaseUrl } from "./openai-service.js";
import { assertSocketHostAllowed, SsrfBlockedError } from "../lib/safe-webhook-fetch.js";

/** The subset of an `api_keys` row (or a ResolvedProfile) the adapter needs. */
export interface StoredCredential {
  provider?: string | null;
  api_key?: string | null;
  base_url?: string | null;
}

export interface ByokTarget {
  conn: Connection;
  credential: string;
  /** How the dashboard tags models from this connection. */
  family: "anthropic" | "ollama" | "openai";
}

/** Provider-specific failure copy for Claude subscription oat tokens, shared
 *  by validation and listing so both surfaces give identical guidance. */
export const SUBSCRIPTION_TOKEN_INVALID =
  "Token expired or invalid — re-run `claude setup-token` and update it in Settings";
export const SUBSCRIPTION_LIMIT_REACHED =
  "Claude subscription limit reached — try again later";

/** Default bound on a listing or validation call. byok's `listModels` takes
 *  no signal yet, so this is a race: the losing request is left to undici's
 *  own timeouts, but the caller is never stranded. */
export const LIST_TIMEOUT_MS = 10_000;

/**
 * Map a stored credential to a byok connection. Returns null when there is
 * no secret to connect with (callers treat that as "no models", not an error).
 */
export function connectionFor(key: StoredCredential): ByokTarget | null {
  const provider = (key.provider ?? "api_key") as ProfileProvider;
  const credential = key.api_key ?? "";
  if (!credential) return null;

  switch (provider) {
    case "ollama":
      // An Ollama Cloud key is a plain Bearer against the OpenAI-compatible
      // surface. OLLAMA_BASE_URL is operator-set (and the E2E mock), not a
      // user-supplied URL, so it is not SSRF-guarded.
      return {
        family: "ollama",
        credential,
        conn: { kind: "openai-compatible", baseUrl: `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1` },
      };
    case "openai":
      return {
        family: "openai",
        credential,
        conn: { kind: "openai-compatible", baseUrl: `${normalizeOpenAIBaseUrl(key.base_url)}/v1` },
      };
    case "openai_subscription":
      return {
        family: "openai",
        credential,
        conn: { kind: "chatgpt", baseUrl: "", accountId: accountIdFromJwt(credential) },
      };
    case "claude_subscription":
      // Both a `claude setup-token` (sk-ant-oat01-) and a Sign-in-with-Claude
      // access token ride in Authorization: Bearer; byok picks that from `auth`.
      return {
        family: "anthropic",
        credential,
        conn: { kind: "anthropic", baseUrl: "", auth: isSetupToken(credential) ? "setup-token" : "oauth" },
      };
    case "api_key":
    default:
      return { family: "anthropic", credential, conn: { kind: "anthropic", baseUrl: "", auth: "key" } };
  }
}

const isSetupToken = (token: string) => token.startsWith("sk-ant-oat01-");

/**
 * SSRF guard for a user-supplied OpenAI-compatible base URL. byok uses the
 * global fetch, so the connection can't be pinned to the validated IP the way
 * safeFetchCore does; the host is resolved and checked against the blocked
 * ranges right before the call instead. Operator-set roots (the OpenAI
 * default, OLLAMA_BASE_URL) and the fixed Anthropic/Codex hosts are exempt.
 */
export async function assertTargetAllowed(target: ByokTarget, key: StoredCredential): Promise<void> {
  if (target.conn.kind !== "openai-compatible" || target.family !== "openai") return;
  if (!(key.base_url ?? "").trim()) return;
  await assertSocketHostAllowed(new URL(target.conn.baseUrl).hostname);
}

/** Resolve a promise or fail after `ms` with `message`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** HTTP status from a byok error ("HTTP 401: …"), or undefined. */
export function statusOf(message: string): number | undefined {
  const m = /^HTTP (\d{3})/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * Turn a byok failure into the copy the dashboard shows. byok's wording is
 * generic ("HTTP 401: invalid x-api-key"); the subscription and rate-limit
 * cases get the guidance users need to fix them.
 */
export function describeFailure(provider: string | null | undefined, err: unknown): string {
  if (err instanceof SsrfBlockedError) return `Base URL not allowed: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(message);
  const subscription = provider === "claude_subscription";
  const anthropic = subscription || provider === "api_key" || !provider;
  if (status === 401) {
    if (subscription) return SUBSCRIPTION_TOKEN_INVALID;
    return anthropic ? "Invalid API key" : message;
  }
  if (status === 403 && anthropic) return "Key is disabled or lacks permissions";
  if (status === 429) {
    if (subscription) return SUBSCRIPTION_LIMIT_REACHED;
    return anthropic ? "Rate limit reached — try again later" : message;
  }
  return message;
}

/** The models a stored credential can run, through byok. Throws in words. */
export async function listModelsFor(key: StoredCredential, timeoutMs = LIST_TIMEOUT_MS) {
  const target = connectionFor(key);
  if (!target) throw new Error("Enter an API key first.");
  await assertTargetAllowed(target, key);
  return withTimeout(listModels(target.conn, target.credential), timeoutMs, "Provider unreachable (timeout)");
}

/**
 * One server-side model turn (judge, titles) through byok. Returns the text,
 * or throws with byok's error so callers log/degrade as before.
 */
export async function completeText(
  key: StoredCredential,
  model: string,
  req: Omit<ChatRequest, "model">,
  options: ChatOptions = {},
): Promise<string> {
  const target = connectionFor(key);
  if (!target) throw new Error("no API key");
  await assertTargetAllowed(target, key);
  const result = await chat(target.conn, target.credential, { ...req, model }, options);
  if (!result.ok) throw new Error(result.error ?? "model call failed");
  return result.text ?? "";
}

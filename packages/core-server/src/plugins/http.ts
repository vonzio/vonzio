// The audited outbound HTTP surface handed to plugins as `ctx.http` (gated by
// the `http.outbound` capability). Every call is SSRF-checked + allowlist-
// checked (manifest∩policy hosts) and logged.
//
// Also provides best-effort detection of plugins that reach for the GLOBAL
// `fetch` instead of `ctx.http.fetch`. This is an OBSERVABILITY aid, not a
// control: it only covers `globalThis.fetch` (not undici-imported fetch,
// http.request, raw sockets) and only fires while the plugin's async context
// is on the stack. Operators must not treat it as enforcement (§10).

import { AsyncLocalStorage } from "node:async_hooks";
import {
  CapabilityViolationError,
  OutboundHostViolationError,
  matchOutboundHost,
  type MtlsRef,
  type PluginHttp,
  type PluginHttpInit,
} from "@vonzio/plugin-api";
import { safeFetchCore, type MtlsMaterial, type SafeFetchInit } from "../lib/safe-webhook-fetch.js";

/** Structural check that an init.mtls value is a genuine MtlsRef (a plugin
 *  could pass an arbitrary object — we only trust the brand + a string name,
 *  and the name must still resolve in mtlsMaterial below). */
function asMtlsRef(value: unknown): MtlsRef | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return v.__vonzioMtls === true && typeof v.name === "string" ? (v as unknown as MtlsRef) : null;
}

/** Default + ceiling timeouts / sizes for plugin HTTP (§10). */
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const MAX_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface PluginHttpCallLog {
  plugin: string;
  host: string;
  method: string;
  status: number;
  durationMs: number;
  /** Logical mtls secret name, when the call presented a client cert. */
  mtls?: string;
}

export interface MakePluginHttpOpts {
  pluginName: string;
  /** The granted (manifest∩policy) outbound host patterns, normalized. */
  grantedHosts: readonly string[];
  /** Pre-loaded mTLS material keyed by logical name (read from the operator's
   *  host files at load). A plugin reaches it only by passing the matching
   *  opaque MtlsRef; the bytes live in this closure, never in plugin memory. */
  mtlsMaterial?: ReadonlyMap<string, MtlsMaterial>;
  /** Registry of refs minted by ctx.secrets.mtls. When provided, an mtls ref
   *  must be a member — so a plugin can't forge a ref object and skip the
   *  audited ctx.secrets.mtls() resolution. */
  issuedMtlsRefs?: WeakSet<object>;
  /** Called once per completed call for the audit log. */
  onCall?: (log: PluginHttpCallLog) => void;
  /** Called when a host fails the allowlist (before the request is made). */
  onViolation?: (info: { plugin: string; host: string }) => void;
}

/**
 * Build the `ctx.http` surface for a plugin that declared http.outbound.
 * Returns a real WHATWG Response reconstructed from the SSRF-checked bytes, so
 * plugin code keeps `.json()` / `.ok` / `.text()` / `.arrayBuffer()`.
 */
export function makePluginHttp(opts: MakePluginHttpOpts): PluginHttp {
  const { pluginName, grantedHosts } = opts;

  return {
    async fetch(url: string, init: PluginHttpInit = {}): Promise<Response> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new OutboundHostViolationError({ plugin: pluginName, host: url });
      }
      const host = parsed.hostname;
      if (!matchOutboundHost(host, grantedHosts)) {
        opts.onViolation?.({ plugin: pluginName, host });
        throw new OutboundHostViolationError({ plugin: pluginName, host });
      }

      // Resolve an mTLS ref (if any) into pre-loaded cert/key material. The ref
      // carries only a logical name; the bytes come from this closure's map, so
      // the plugin never holds the key. An unrecognized/unprovisioned name is a
      // capability violation (defense in depth — the loader already validated).
      let mtls: MtlsMaterial | undefined;
      let mtlsName: string | undefined;
      if (init.mtls !== undefined) {
        const ref = asMtlsRef(init.mtls);
        // The ref must have been minted by ctx.secrets.mtls (membership) AND
        // resolve to provisioned material. A forged object — or a ref the
        // plugin never resolved through the audited surface — is refused.
        const issued = ref ? opts.issuedMtlsRefs?.has(ref) ?? true : false;
        const material = ref ? opts.mtlsMaterial?.get(ref.name) : undefined;
        if (!ref || !issued || !material) {
          throw new CapabilityViolationError({
            plugin: pluginName,
            capability: "secrets.mtls",
            key: `ctx.http.fetch(mtls:${ref?.name ?? "<invalid>"})`,
          });
        }
        mtls = material;
        mtlsName = ref.name;
      }

      const method = init.method ?? "GET";
      const coreInit: SafeFetchInit = {
        method,
        headers: init.headers,
        body: init.body,
        ...(mtls ? { mtls } : {}),
      };
      const timeoutMs = Math.min(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const maxResponseBytes = Math.min(init.maxResponseBytes ?? DEFAULT_MAX_BYTES, MAX_MAX_BYTES);

      const startedAt = performance.now();
      const result = await safeFetchCore(url, coreInit, {
        timeoutMs,
        maxResponseBytes,
        // Re-check the allowlist on every redirect hop: an allowlisted host
        // that 302-redirects to another (public) host must NOT bypass the
        // per-plugin outboundHosts allowlist.
        onRedirectHop: (hopUrl) => {
          let hopHost: string;
          try {
            hopHost = new URL(hopUrl).hostname;
          } catch {
            throw new OutboundHostViolationError({ plugin: pluginName, host: hopUrl });
          }
          if (!matchOutboundHost(hopHost, grantedHosts)) {
            opts.onViolation?.({ plugin: pluginName, host: hopHost });
            throw new OutboundHostViolationError({ plugin: pluginName, host: hopHost });
          }
        },
      });
      const durationMs = Math.round(performance.now() - startedAt);

      opts.onCall?.({ plugin: pluginName, host, method, status: result.status, durationMs, ...(mtlsName ? { mtls: mtlsName } : {}) });

      // Rebuild a real Response. Drop hop-by-hop / forbidden response headers
      // the Response constructor would reject; keep the rest (content-type etc.).
      const safeHeaders = new Headers();
      result.headers.forEach((value, key) => {
        try {
          safeHeaders.set(key, value);
        } catch {
          /* skip headers the Response ctor refuses */
        }
      });
      return new Response(result.bytes, {
        status: result.status,
        statusText: result.statusText,
        headers: safeHeaders,
      });
    },
  };
}

// ── Best-effort raw-fetch detection via AsyncLocalStorage ───────────────────

interface PluginAsyncTag {
  plugin: string;
  hasHttpOutbound: boolean;
}

const pluginContext = new AsyncLocalStorage<PluginAsyncTag>();

/** Run `fn` tagged with the plugin's async context (the loader wraps init()). */
export function runInPluginContext<T>(tag: PluginAsyncTag, fn: () => T): T {
  return pluginContext.run(tag, fn);
}

let guardInstalled = false;

/**
 * Wrap `globalThis.fetch` once so that when a plugin WITHOUT http.outbound is
 * on the async stack and calls the global fetch, an anomaly is logged. The
 * call is NOT blocked (a non-vonzio library that fetches internally on
 * legitimate use would otherwise self-DoS). Idempotent.
 */
export function installGlobalFetchGuard(onAnomaly: (info: { plugin: string; url: string }) => void): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = function guardedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const tag = pluginContext.getStore();
    if (tag && !tag.hasHttpOutbound) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url ?? input);
      try {
        onAnomaly({ plugin: tag.plugin, url });
      } catch {
        /* never let the audit hook break a fetch */
      }
    }
    return original.call(this, input as RequestInfo, init);
  } as typeof fetch;
}

/** Test-only: reset the guard so a test can re-install it. */
export function __resetFetchGuardForTest(): void {
  guardInstalled = false;
}

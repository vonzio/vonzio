import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Process-wide AsyncLocalStorage that pins the active organization id
 * to the current async chain. The shape is intentionally minimal — a
 * single string — so the cost of reading at every potential workspace-
 * insert site is one map lookup.
 *
 * **Producers (set the value):**
 *   - cp-server's permissive orgContext middleware wraps Fastify's
 *     continuation in `runWithOrgIdContinuation(org_id, done)` on every
 *     HTTP request after resolving the X-Org-Id header or `?org_id`
 *     query param. The value propagates through every `await` in the
 *     request lifetime.
 *   - The WS message handler wraps each incoming message in
 *     `runWithOrgId(connectionOrgId, ...)` so the org pinned at WS
 *     upgrade time flows through any code the message triggers.
 *   - The orchestrator wraps each `dispatchTask` call in
 *     `runWithOrgId(resolveOrgIdForTask(task.id), ...)` so background
 *     work that has no request context still tags its rows.
 *
 * **Consumers (read the value):**
 *   - `SessionRegistry.register()` falls back to `getActiveOrgId()`
 *     when the explicit `orgId` parameter is omitted — this is the
 *     hook that makes every workspace insert path uniformly org-tagged
 *     without each caller having to know about orgs.
 *   - Any future write site that wants to be org-scoped can call
 *     `getActiveOrgId()` directly.
 *
 * OSS deployments never set the value (no cp-server, no global hook),
 * so the storage is always empty and downstream writes get
 * `org_id=null` — the existing behavior.
 */
const orgIdStorage = new AsyncLocalStorage<string>();

/**
 * Read the active org id from the current async chain. Returns `null`
 * when nothing is pinned (OSS deployments, background workers not
 * wrapped by `runWithOrgId`, system-event paths).
 */
export function getActiveOrgId(): string | null {
  return orgIdStorage.getStore() ?? null;
}

/**
 * Run `fn` inside a fresh async-local scope with `orgId` pinned. The
 * returned promise resolves with `fn`'s result. When `orgId` is null
 * the storage is not entered — `getActiveOrgId()` returns whatever
 * the surrounding context had (or null).
 *
 * Use this for callback boundaries: WS message handlers, orchestrator
 * dispatch tasks, anywhere you receive an event with a known org and
 * want all downstream code to see it.
 */
export async function runWithOrgId<T>(
  orgId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!orgId) return fn();
  return orgIdStorage.run(orgId, fn);
}

/**
 * Sync continuation-wrapping variant for Fastify callback-style hooks.
 * `als.enterWith` doesn't work reliably when called from inside an async
 * hook because Fastify's continuation runs in a different async chain
 * than the one that called enterWith. Wrapping `next` inside `als.run`
 * is the only pattern that guarantees the rest of the request — every
 * subsequent hook, the route handler, and any code they await — sees
 * `getActiveOrgId() === orgId`.
 */
export function runWithOrgIdContinuation(
  orgId: string | null,
  next: (err?: Error) => void,
): void {
  if (!orgId) return next();
  orgIdStorage.run(orgId, () => next());
}

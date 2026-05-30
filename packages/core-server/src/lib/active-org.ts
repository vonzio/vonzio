import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Process-wide AsyncLocalStorage that pins the active organization id
 * to the current async chain. The shape is intentionally minimal — a
 * single string — so the cost of reading at every potential workspace-
 * insert site is one map lookup.
 *
 * **Producers (set the value):**
 *   - cp-server's permissive orgContext middleware calls
 *     `setActiveOrgId(org_id)` on every HTTP request after resolving
 *     the X-Org-Id header or `?org_id` query param. The value
 *     propagates through every `await` in the request lifetime.
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
 * Pin an org id to the current async chain. Subsequent reads of
 * `getActiveOrgId()` from the same chain (including through `await`
 * boundaries) return this value. Idempotent re-entry with the same
 * value is a no-op.
 *
 * Use this from Fastify hooks (`preHandler`, `onRequest`) where you
 * can't wrap downstream work in a callback — the hook sets the
 * value, then returns, and Fastify resumes the request inside the
 * same async chain. For callback-style integration (e.g. WS message
 * handler, orchestrator dispatch) prefer `runWithOrgId`.
 */
export function setActiveOrgId(orgId: string | null): void {
  if (orgId) orgIdStorage.enterWith(orgId);
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

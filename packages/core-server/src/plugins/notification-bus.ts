import type {
  NotificationBus,
  NotificationHandler,
  NotificationRequest,
  NotificationResult,
} from "@vonzio/plugin-api";

/**
 * Process-local registry of plugin notification handlers. Plugins call
 * `registerHandler("telegram", handler)` in their `init()`; core
 * services call `dispatch({ kind: "telegram", ... })` to route an
 * outbound notification to whichever plugin claimed that kind.
 *
 * One handler per kind by construction -- attempting to register a
 * second handler for the same kind throws at boot, which catches the
 * "two plugins both claim email" misconfig before any traffic flows.
 *
 * The interface `NotificationBus` (from `@vonzio/plugin-api`) only
 * exposes `registerHandler` to plugins. `dispatch` is core-only -- it
 * lives on this class so plugins can't dispatch into each other, which
 * keeps the leaf-node plugin model intact.
 */
export class NotificationBusImpl implements NotificationBus {
  private handlers = new Map<string, NotificationHandler>();

  registerHandler(kind: string, handler: NotificationHandler): void {
    if (!kind || typeof kind !== "string") {
      throw new Error(`notification kind must be a non-empty string, got ${JSON.stringify(kind)}`);
    }
    if (this.handlers.has(kind)) {
      throw new Error(
        `notification handler for kind "${kind}" already registered. Two plugins cannot claim the same kind.`,
      );
    }
    this.handlers.set(kind, handler);
  }

  /**
   * Send an outbound notification. Returns the plugin handler's result,
   * or a synthetic { ok: false, retryable: false } if no handler claims
   * the kind. Never throws -- handlers MAY throw and that becomes
   * a non-retryable error result (the bus is the trust boundary).
   */
  async dispatch(req: NotificationRequest): Promise<NotificationResult> {
    const handler = this.handlers.get(req.kind);
    if (!handler) {
      return {
        ok: false,
        error: `no plugin registered for notification kind "${req.kind}"`,
        retryable: false,
      };
    }
    try {
      return await handler(req);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }
  }

  /** For tests + debug endpoints. */
  registeredKinds(): string[] {
    return [...this.handlers.keys()];
  }
}

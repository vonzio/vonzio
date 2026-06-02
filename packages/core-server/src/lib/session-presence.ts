// Session-presence registry. Holds chat-surface providers (currently:
// telegram via the plugin, slack as a still-in-core builtin) and
// exposes aggregate queries to the orchestrator, ask-user fallback,
// and workspace service.
//
// Why this exists: before this module, core read from telegram
// tables directly in three places (orchestrator.resolvePresence,
// ask-user-fallback.hasInBandSurface/resolveUserId,
// workspace-service.list). That coupling blocked the telegram schema
// move (Phase 3D.1c) and the telegram-events.ts move (Phase 3D.1d.1).
// Inverting through a provider registry lets each surface owner
// (plugin or builtin) keep the reads on its side of the boundary;
// core just iterates registered providers.
//
// Slack ALSO had direct reads in the same places. Until slack is
// extracted, server.ts registers a builtin slack provider so the
// query path is uniform -- when slack moves out of core, just delete
// the builtin registration and the rest works unchanged.

import type {
  PluginSessionPresenceRegistry,
  PresenceSurfaceMetadata,
  SessionPresenceProvider,
} from "@vonzio/plugin-api";

/**
 * Holds and queries the registered chat-surface providers. One
 * instance per server; passed to the orchestrator, ask-user-fallback,
 * and workspace-service via constructor / deps. Plugins receive only
 * the register-side interface via `ctx.core.sessionPresence`.
 *
 * Provider errors are absorbed (logged as a no-result) so a flaky
 * plugin can't take down the orchestrator's task launch path -- a
 * "we don't know if the surface is reachable" is treated as "it
 * isn't", consistent with the legacy try/catch in resolvePresence
 * and hasInBandSurface.
 */
export class SessionPresenceRegistry implements PluginSessionPresenceRegistry {
  private providers: SessionPresenceProvider[] = [];

  register(provider: SessionPresenceProvider): void {
    const existing = this.providers.find((p) => p.surface === provider.surface);
    if (existing) {
      throw new Error(
        `Session presence provider for surface "${provider.surface}" already registered`,
      );
    }
    this.providers.push(provider);
  }

  list(): readonly SessionPresenceProvider[] {
    return this.providers;
  }

  /**
   * Returns metadata for every surface that reports the session as
   * bound. Used by the orchestrator's Reachability section -- the
   * agent sees the labels as-is.
   *
   * Providers run in parallel; iteration order in the returned array
   * matches registration order (stable for prompt reproducibility).
   */
  async surfacesFor(sessionId: string): Promise<PresenceSurfaceMetadata[]> {
    const results = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const has = await p.hasSession(sessionId);
          return has ? p.metadata : null;
        } catch {
          // Provider is the failure boundary; "unknown" = "no" so a
          // single broken provider doesn't claim presence on every
          // session.
          return null;
        }
      }),
    );
    return results.filter((m): m is PresenceSurfaceMetadata => m !== null);
  }

  /**
   * "Does any registered surface deliver to this user's account-wide
   * channel?" Used by ask-user-fallback to suppress its
   * plain-text notification when the in-band relay will already
   * surface the question (e.g. telegram with a linked user-DM bot).
   *
   * Providers that don't implement hasOwnerSurface are skipped.
   */
  async anyHasOwnerSurface(userId: string): Promise<boolean> {
    const results = await Promise.all(
      this.providers.map(async (p) => {
        if (!p.hasOwnerSurface) return false;
        try {
          return await p.hasOwnerSurface(userId);
        } catch {
          return false;
        }
      }),
    );
    return results.some(Boolean);
  }

  /**
   * Walks providers in registration order, returning the first
   * non-null user_id. Used by ask-user-fallback when the session
   * isn't yet in the in-process SessionRegistry (race during
   * chat-initiated session creation).
   */
  async resolveUserIdBySession(sessionId: string): Promise<string | null> {
    for (const p of this.providers) {
      if (!p.resolveUserIdBySession) continue;
      try {
        const userId = await p.resolveUserIdBySession(sessionId);
        if (userId) return userId;
      } catch {
        // Try the next provider.
      }
    }
    return null;
  }

  /**
   * Union of session ids the user has actively engaged with across
   * every surface. Used by workspace-service to keep claimed
   * playbook-execution workspaces visible in the chat list.
   */
  async listEngagedSessionIds(): Promise<Set<string>> {
    const sets = await Promise.all(
      this.providers.map(async (p) => {
        if (!p.listEngagedSessionIds) return new Set<string>();
        try {
          return await p.listEngagedSessionIds();
        } catch {
          return new Set<string>();
        }
      }),
    );
    const union = new Set<string>();
    for (const s of sets) for (const id of s) union.add(id);
    return union;
  }
}

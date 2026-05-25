/**
 * Session-aware wrapper around the pure `rewriteAgentImages` helper.
 *
 * Resolves the workspace + friendly container name for a session, builds the
 * `RewriteContext`, and caches container-name lookups so the WS replay loop
 * doesn't fire one Docker inspect per persisted event.
 *
 * Replaces three near-identical helpers that previously lived inside
 * ws/handler.ts, routes/telegram-events.ts, and routes/slack-events.ts.
 */

import { rewriteAgentImages, type RewrittenAgentOutput } from "./agent-output-rewriter.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import type { PreviewAuthChecker } from "../auth/preview-auth.js";

export interface ImageRewriterDeps {
  sessionRegistry: SessionRegistry;
  containerManager: ContainerManager;
  previewAuthChecker: PreviewAuthChecker;
  previewUrlTemplate: string;
}

export class ImageRewriterService {
  // Keyed by full container_id. Each container instance has a stable name
  // for its lifetime; we only ever miss the cache when a session boots
  // a fresh container. No TTL because we want the WS replay loop to hit
  // it for every persisted event without revalidating against Docker.
  private nameCache = new Map<string, string>();

  constructor(private deps: ImageRewriterDeps) {}

  /**
   * Rewrite agent output for a session. Returns null when the session has
   * no live container — the caller can't safely strip-and-resend without
   * an alternate fetch path, so it's better to leave the text as-is.
   */
  async forSession(sessionId: string, text: string): Promise<RewrittenAgentOutput | null> {
    if (!text) return null;
    const workspace = this.deps.sessionRegistry.get(sessionId);
    if (!workspace?.container_id) return null;
    const containerName = await this.resolveContainerName(workspace.container_id);
    return rewriteAgentImages(text, {
      fullContainerId: workspace.container_id,
      userId: workspace.user_id,
      previewUrlTemplate: this.deps.previewUrlTemplate,
      containerName,
      // Wrap signToken in an arrow so the method's `this` binding can't
      // surprise us if the preview-auth implementation ever uses `this`.
      signToken: (cid, uid) => this.deps.previewAuthChecker.signToken(cid, uid),
    });
  }

  /**
   * Convenience for callers that only care about the URL-rewritten text
   * (e.g. the WS broadcast path). Returns the input unchanged when there's
   * no session context — broadcasts continue to work, images just don't render.
   */
  async signImagesIn(sessionId: string, text: string): Promise<string> {
    const result = await this.forSession(sessionId, text);
    return result?.textWithUrls ?? text;
  }

  /**
   * Pre-warmed lookup keyed by container_id (not session_id) so multiple
   * sessions sharing a pooled container hit the same cache slot.
   */
  private async resolveContainerName(fullContainerId: string): Promise<string> {
    const cached = this.nameCache.get(fullContainerId);
    if (cached) return cached;
    const name = (await this.deps.containerManager.getContainerName(fullContainerId))
      ?? fullContainerId.slice(0, 12);
    this.nameCache.set(fullContainerId, name);
    return name;
  }

  /**
   * Drop a cache entry — call when a container is removed so the slot
   * doesn't leak forever. Optional; the leak is bounded and tiny.
   */
  invalidate(fullContainerId: string): void {
    this.nameCache.delete(fullContainerId);
  }
}

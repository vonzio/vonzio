/**
 * Resolve the set of models a profile can use, with a small in-memory
 * cache so we don't hammer the upstream provider on every model-picker
 * open. Used by:
 *   - GET /v1/profiles/:id/models (dashboard composer's ModelPicker)
 *   - Telegram /model command + inline-keyboard picker
 *   - Slack `@vonzio model` mention + static_select picker
 *
 * The cache key is the API-key id (not the profile id) so two profiles
 * sharing the same key share the cache entry. TTL is 5 minutes —
 * provider model lists change rarely enough that staleness within a
 * 5-min window is acceptable, and refreshing on each picker open
 * would be wasteful for the common case.
 *
 * Errors from the upstream are returned as a discriminated result so
 * callers (routes, bot handlers) can decide their own user-facing
 * presentation (HTTP code vs Telegram error reply).
 */

import type { ProfileService } from "./profile-service.js";
import type { ApiKeyService } from "./api-key-service.js";
import { connectionFor, describeFailure, listModelsFor } from "./byok-connection.js";

export interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama" | "openai";
}

export type ModelListResult =
  | {
      ok: true;
      models: ProfileModel[];
      /**
       * The profile's default model id at the time of the lookup.
       * Returned alongside `models` so bot pickers (and the dashboard,
       * eventually) don't have to follow up with a separate
       * profileService.get just to render the "current" marker.
       * `null` when the profile has no default configured.
       */
      profileDefault: string | null;
    }
  | { ok: false; status: number; error: string };

interface CacheEntry {
  models: ProfileModel[];
  ts: number;
}

const MODELS_CACHE_TTL = 5 * 60_000;

export class ModelListService {
  private cache = new Map<string, CacheEntry>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    private profileService: ProfileService,
    private apiKeyService: ApiKeyService,
  ) {
    // Periodic sweep so a high-churn server doesn't accumulate stale
    // entries indefinitely. .unref() so this never holds the event
    // loop open during shutdown.
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.ts > MODELS_CACHE_TTL) this.cache.delete(key);
      }
    }, MODELS_CACHE_TTL);
    this.cleanupInterval.unref?.();
  }

  /**
   * Server-lifecycle close hook. Call from the same `server.addHook("onClose", ...)`
   * the route plugin used to register on its own — keeping the cleanup
   * symmetric with construction.
   */
  stop(): void {
    clearInterval(this.cleanupInterval);
  }

  /** Drop the cached model list for a key. Call when its credential or
   *  base_url changes so the next lookup reflects the new endpoint instead
   *  of serving the old provider's models for up to the TTL. */
  invalidate(apiKeyId: string): void {
    this.cache.delete(apiKeyId);
  }

  /**
   * Fetch the models a profile can use. Returns `{ ok: true, models: [] }`
   * (NOT an error) for the "no API key configured" case — the UI should
   * surface that as "no models available," not as a failure.
   */
  async listForProfile(profileId: string): Promise<ModelListResult> {
    const profile = await this.profileService.get(profileId);
    if (!profile) return { ok: false, status: 404, error: "Profile not found" };
    const profileDefault = profile.model ?? null;
    if (!profile.api_key_id) return { ok: true, models: [], profileDefault };
    const inner = await this.listForApiKey(profile.api_key_id);
    if (!inner.ok) return inner;
    return { ok: true, models: inner.models, profileDefault };
  }

  /**
   * Same fetch as listForProfile but keyed by the api_key_id directly —
   * used by SaaS surfaces (org-agent editor) that need the model list
   * without going through an OSS profile row. `profileDefault` is always
   * null here; the caller already knows the default of whichever
   * resource they're editing.
   */
  async listForApiKey(apiKeyId: string): Promise<ModelListResult> {
    const cached = this.cache.get(apiKeyId);
    if (cached && Date.now() - cached.ts < MODELS_CACHE_TTL) {
      return { ok: true, models: cached.models, profileDefault: null };
    }

    const apiKey = await this.apiKeyService.getWithSecrets(apiKeyId);
    if (!apiKey) return { ok: true, models: [], profileDefault: null };

    const target = connectionFor(apiKey);
    if (!target) return { ok: true, models: [], profileDefault: null };

    let models: ProfileModel[];
    try {
      models = (await this.fetchModels(apiKey)).map((m) => ({
        id: m.id,
        display_name: m.name && m.name !== m.id ? m.name : null,
        provider: target.family,
      }));
    } catch (err) {
      // Keep HTTP 502 (a 401 here would read as a *session* logout to the
      // SPA); only sharpen the message.
      return { ok: false, status: 502, error: describeFailure(apiKey.provider, err) };
    }

    this.cache.set(apiKeyId, { models, ts: Date.now() });
    return { ok: true, models, profileDefault: null };
  }

  /**
   * byok lists every provider live (Anthropic, OpenAI-compatible, the Codex
   * catalog). The one override: a ChatGPT key with CODEX_MODELS set uses that
   * static list, and a Codex catalog failure falls back to the baked list so
   * a transient backend error doesn't empty the picker.
   */
  private async fetchModels(apiKey: { provider: string; api_key?: string | null; base_url?: string | null }) {
    if (apiKey.provider === "openai_subscription") {
      const { codexModels } = await import("./codex-oauth-service.js");
      if ((process.env.CODEX_MODELS ?? "").trim()) return codexModels().map((id) => ({ id, name: id }));
      try {
        return await listModelsFor(apiKey);
      } catch {
        return codexModels().map((id) => ({ id, name: id }));
      }
    }
    return listModelsFor(apiKey);
  }
}

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
import { fetchOllamaModels } from "./ollama-service.js";

export interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama";
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
const ANTHROPIC_FETCH_TIMEOUT_MS = 10_000;

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

    const cached = this.cache.get(profile.api_key_id);
    if (cached && Date.now() - cached.ts < MODELS_CACHE_TTL) {
      return { ok: true, models: cached.models, profileDefault };
    }

    const apiKey = await this.apiKeyService.getWithSecrets(profile.api_key_id);
    if (!apiKey) return { ok: true, models: [], profileDefault };

    let models: ProfileModel[] = [];
    try {
      if (apiKey.provider === "ollama") {
        if (!apiKey.api_key) return { ok: true, models: [], profileDefault };
        const ollama = await fetchOllamaModels(apiKey.api_key);
        models = ollama.map((m) => ({
          id: m.id,
          display_name: m.name ?? null,
          provider: "ollama" as const,
        }));
      } else {
        // Anthropic — `api_key` is the BYO key, `auth_token` covers the
        // subscription-token case (both proxy through here today).
        const secret = apiKey.api_key ?? apiKey.auth_token;
        if (!secret) return { ok: true, models: [], profileDefault };
        const res = await fetch("https://api.anthropic.com/v1/models", {
          method: "GET",
          headers: {
            "x-api-key": secret,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(ANTHROPIC_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { ok: false, status: 502, error: `Anthropic API returned ${res.status}` };
        }
        const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
        models = (data.data ?? []).map((m) => ({
          id: m.id,
          display_name: m.display_name ?? null,
          provider: "anthropic" as const,
        }));
      }
    } catch (err) {
      return { ok: false, status: 502, error: err instanceof Error ? err.message : "Failed to fetch models" };
    }

    this.cache.set(profile.api_key_id, { models, ts: Date.now() });
    return { ok: true, models, profileDefault };
  }
}

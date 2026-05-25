import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelListService } from "./model-list-service.js";
import type { ProfileService } from "./profile-service.js";
import type { ApiKeyService } from "./api-key-service.js";

/**
 * The service has three external dependencies:
 *   - profileService.get → checks profile exists + finds api_key_id
 *   - apiKeyService.getWithSecrets → returns the resolved key + provider
 *   - global fetch → Anthropic /v1/models (mocked per test)
 *   - fetchOllamaModels (mocked via vi.mock at the module boundary)
 */
vi.mock("./ollama-service.js", () => ({
  fetchOllamaModels: vi.fn(),
}));

import { fetchOllamaModels } from "./ollama-service.js";

function makeServices(profile: unknown, apiKey: unknown) {
  return {
    profileService: { get: vi.fn(async () => profile) } as unknown as ProfileService,
    apiKeyService: { getWithSecrets: vi.fn(async () => apiKey) } as unknown as ApiKeyService,
  };
}

const PROFILE_WITH_ANTHROPIC = {
  id: "prof_1",
  name: "Default",
  api_key_id: "key_anth",
  user_id: "user_1",
};

const PROFILE_WITH_OLLAMA = {
  id: "prof_2",
  name: "Ollama",
  api_key_id: "key_ollama",
  user_id: "user_1",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelListService", () => {
  it("returns 404 when the profile does not exist", async () => {
    const { profileService, apiKeyService } = makeServices(null, null);
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toMatch(/not found/i);
    }
    svc.stop();
  });

  it("returns an empty list (not an error) when the profile has no api_key_id", async () => {
    const { profileService, apiKeyService } = makeServices(
      { ...PROFILE_WITH_ANTHROPIC, api_key_id: null },
      null,
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result).toEqual({ ok: true, models: [], profileDefault: null });
    svc.stop();
  });

  it("fetches Anthropic models and tags them with provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "claude-opus-4-7", display_name: "Opus 4.7" }, { id: "claude-haiku-4-5", display_name: "Haiku 4.5" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "sk-anth-test", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toHaveLength(2);
      expect(result.models[0]).toEqual({
        id: "claude-opus-4-7",
        display_name: "Opus 4.7",
        provider: "anthropic",
      });
    }
    svc.stop();
  });

  it("delegates to fetchOllamaModels for ollama keys", async () => {
    (fetchOllamaModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "llama3", name: "Llama 3" },
      { id: "qwen2", name: null },
    ]);

    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_OLLAMA,
      { provider: "ollama", api_key: "http://localhost:11434", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([
        { id: "llama3", display_name: "Llama 3", provider: "ollama" },
        { id: "qwen2", display_name: null, provider: "ollama" },
      ]);
    }
    svc.stop();
  });

  it("returns ok:true with empty models when the Ollama key is missing", async () => {
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_OLLAMA,
      { provider: "ollama", api_key: null, auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_2");
    expect(result).toEqual({ ok: true, models: [], profileDefault: null });
    svc.stop();
  });

  it("falls back from api_key to auth_token for Anthropic subscription-token keys", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: null, auth_token: "sk-ant-sub" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    await svc.listForProfile("prof_1");
    const headers = (fetchSpy.mock.calls as unknown as Array<[unknown, { headers: Record<string, string> }]>)[0][1].headers;
    expect(headers["x-api-key"]).toBe("sk-ant-sub");
    svc.stop();
  });

  it("returns 502 when Anthropic responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "bad", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/401/);
    }
    svc.stop();
  });

  it("caches results keyed by api_key_id (second call doesn't refetch)", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "x", display_name: "X" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "k", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    await svc.listForProfile("prof_1");
    await svc.listForProfile("prof_1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it("returns profileDefault alongside models so callers don't need a separate profileService.get", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5", display_name: "Haiku 4.5" }] }), { status: 200 })));
    const { profileService, apiKeyService } = makeServices(
      { ...PROFILE_WITH_ANTHROPIC, model: "claude-sonnet-4-6" },
      { provider: "anthropic", api_key: "k", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profileDefault).toBe("claude-sonnet-4-6");
    }
    svc.stop();
  });

  it("returns 502 when the upstream fetch throws (timeout / network error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("EHOSTUNREACH"); }));
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "k", auth_token: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain("EHOSTUNREACH");
    }
    svc.stop();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelListService } from "./model-list-service.js";
import type { ProfileService } from "./profile-service.js";
import type { ApiKeyService } from "./api-key-service.js";

/**
 * The service has three external dependencies:
 *   - profileService.get → checks profile exists + finds api_key_id
 *   - apiKeyService.getWithSecrets → returns the resolved key + provider
 *   - global fetch → every provider's model listing, via byok (stubbed per test)
 */
const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers as HeadersInit | undefined).get(name);

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

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
    expect(result).toEqual({ ok: true, models: [], profileDefault: null, defaultModel: null });
    svc.stop();
  });

  it("fetches Anthropic models and tags them with provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "claude-opus-4-7", display_name: "Opus 4.7" }, { id: "claude-haiku-4-5", display_name: "Haiku 4.5" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "sk-anth-test" },
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

  it("lists ollama keys against the Ollama OpenAI-compatible /v1/models with a Bearer", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ id: "qwen2" }, { id: "llama3" }] }));
    vi.stubGlobal("fetch", fetchSpy);

    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_OLLAMA,
      { provider: "ollama", api_key: "ollama-key" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // byok sorts by id; Ollama has no display names.
      expect(result.models).toEqual([
        { id: "llama3", display_name: null, provider: "ollama" },
        { id: "qwen2", display_name: null, provider: "ollama" },
      ]);
    }
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/ollama\.com\/v1\/models$/);
    expect(headerOf(init, "authorization")).toBe("Bearer ollama-key");
    svc.stop();
  });

  it("lists openai keys at the key's base_url and tags them openai", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-x" }] }));
    vi.stubGlobal("fetch", fetchSpy);

    const { profileService, apiKeyService } = makeServices(
      { id: "prof_3", name: "OpenAI", api_key_id: "key_openai", user_id: "user_1" },
      { provider: "openai", api_key: "sk-openai-test", auth_token: null, base_url: "https://openrouter.ai/api/v1" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_3");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([{ id: "gpt-x", display_name: null, provider: "openai" }]);
    }
    const [url] = fetchSpy.mock.calls[0] as unknown as [URL | string];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
    svc.stop();
  });

  it("refuses an openai base_url that resolves to a private address", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      { id: "prof_3", name: "OpenAI", api_key_id: "key_openai", user_id: "user_1" },
      { provider: "openai", api_key: "sk", base_url: "http://169.254.169.254" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_3");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    svc.stop();
  });

  it("lists ChatGPT keys from the live Codex catalog and falls back to the baked list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { profileService, apiKeyService } = makeServices(
      { id: "prof_4", name: "ChatGPT", api_key_id: "key_codex", user_id: "user_1" },
      { provider: "openai_subscription", api_key: "eyJ.eyJ.sig" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.every((m) => m.provider === "openai")).toBe(true);
    }
    svc.stop();
  });

  it("lists an OpenCode sign-in live from OpenCode's API with the token and org", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }] }));
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      { id: "prof_5", name: "OpenCode", api_key_id: "key_opencode", user_id: "user_1" },
      { provider: "opencode", api_key: "oc-token", account_id: "org_1" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_5");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6", "gpt-5.5"]);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toBe("https://opencode.ai/inference/v1/models");
    expect(headerOf(init, "authorization")).toBe("Bearer oc-token");
    expect(headerOf(init, "x-opencode-org-id")).toBe("org_1");
    svc.stop();
  });

  it("returns ok:true with empty models when the Ollama key is missing", async () => {
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_OLLAMA,
      { provider: "ollama", api_key: null },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_2");
    expect(result).toEqual({ ok: true, models: [], profileDefault: null, defaultModel: null });
    svc.stop();
  });

  it("returns 502 when Anthropic responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "bad" },
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

  it("fetches Anthropic models with a Bearer header for claude_subscription", async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "claude-opus-4-8", display_name: "Opus 4.8" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "claude_subscription", api_key: "sk-ant-oat01-tok" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models[0].provider).toBe("anthropic");
    // Authenticated via Bearer, NOT x-api-key.
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(headerOf(init, "authorization")).toBe("Bearer sk-ant-oat01-tok");
    expect(headerOf(init, "x-api-key")).toBeNull();
    svc.stop();
  });

  it("maps a 401 for claude_subscription to a re-run-setup-token message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "claude_subscription", api_key: "sk-ant-oat01-expired" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForProfile("prof_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/setup-token/);
    }
    svc.stop();
  });

  it("caches results keyed by api_key_id (second call doesn't refetch)", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "x", display_name: "X" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { profileService, apiKeyService } = makeServices(
      PROFILE_WITH_ANTHROPIC,
      { provider: "anthropic", api_key: "k" },
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
      { provider: "anthropic", api_key: "k" },
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
      { provider: "anthropic", api_key: "k" },
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
  it("leaves OpenCode's free-tier models out of the list and the default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      object: "list",
      data: ["big-pickle", "beam-free", "glm-5.3-flash-free", "glm-5.3", "kimi-k3"].map((id) => ({ id, object: "model", owned_by: "opencode" })),
    })));
    const { profileService, apiKeyService } = makeServices(
      { ...PROFILE_WITH_ANTHROPIC, api_key_id: "key_oc" },
      { provider: "opencode", api_key: "oc-token", account_id: "org_1" },
    );
    const svc = new ModelListService(profileService, apiKeyService);
    const result = await svc.listForApiKey("key_oc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.map((m) => m.id)).toEqual(["glm-5.3", "kimi-k3"]);
      expect(result.defaultModel).toBe("kimi-k3");
    }
    svc.stop();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAuthorizationInput,
  startOAuth,
  completeOAuth,
  refreshAnthropicTokens,
  needsRefresh,
  ANTHROPIC_OAUTH_TIMEOUT_MS,
} from "./anthropic-oauth-service.js";

const KEY = "unit-test-encryption-key-32chars!";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The state param the consent URL carries (what the consent page echoes as the `#state` half). */
const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("state")!;

describe("anthropic-oauth-service", () => {
  it("parses the code#state string the consent page displays", () => {
    expect(parseAuthorizationInput("abc123#st456")).toEqual({ code: "abc123", state: "st456" });
    expect(parseAuthorizationInput("https://platform.claude.com/oauth/code/callback?code=xyz&state=st")).toEqual({ code: "xyz", state: "st" });
    expect(parseAuthorizationInput("  rawcode  ")).toEqual({ code: "rawcode" });
    expect(parseAuthorizationInput("")).toEqual({});
  });

  it("consent URL: PKCE display mode, inference scope, no '+' encoding", async () => {
    const { authorize_url } = await startOAuth("user_1", KEY);
    expect(authorize_url).not.toContain("+");
    const url = new URL(authorize_url);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("user:inference");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("completes a sign-in end to end (sealed auth_id, PKCE verifier sent, skewed expiry)", async () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    vi.useFakeTimers({ now });
    try {
      const { auth_id, authorize_url } = await startOAuth("user_1", KEY, now);
      const spy = stubFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
      const tokens = await completeOAuth(auth_id, "user_1", `thecode#${stateOf(authorize_url)}`, KEY, now);
      expect(tokens.accessToken).toBe("at");
      expect(tokens.refreshToken).toBe("rt");
      expect(tokens.expiresAt).toBe(new Date(now + 55 * 60 * 1000).toISOString()); // 1h − 5min skew
      const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      const sent = JSON.parse(String(init.body)) as Record<string, string>;
      expect(sent.grant_type).toBe("authorization_code");
      expect(sent.code).toBe("thecode");
      expect(sent.code_verifier).toBeTruthy();
      expect(sent.code_verifier).not.toBe(sent.state);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the auth token to the initiating user", async () => {
    const { auth_id, authorize_url } = await startOAuth("user_1", KEY);
    stubFetch(200, {});
    await expect(completeOAuth(auth_id, "user_EVIL", `code#${stateOf(authorize_url)}`, KEY)).rejects.toThrow(/different user/i);
  });

  it("REQUIRES the state half and rejects a wrong state or a tampered auth token", async () => {
    const { auth_id } = await startOAuth("user_1", KEY);
    stubFetch(200, {});
    await expect(completeOAuth(auth_id, "user_1", "just-a-code", KEY)).rejects.toThrow(/FULL code/i);
    await expect(completeOAuth(auth_id, "user_1", "code#WRONG", KEY)).rejects.toThrow(/state mismatch/i);
    await expect(completeOAuth("AAAA" + auth_id.slice(4), "user_1", "code#x", KEY)).rejects.toThrow(/invalid/i);
  });

  it("expires the auth token after the TTL", async () => {
    const t0 = Date.parse("2026-08-12T00:00:00Z");
    const { auth_id, authorize_url } = await startOAuth("user_1", KEY, t0);
    stubFetch(200, {});
    await expect(
      completeOAuth(auth_id, "user_1", `code#${stateOf(authorize_url)}`, KEY, t0 + ANTHROPIC_OAUTH_TIMEOUT_MS + 1),
    ).rejects.toThrow(/expired/i);
  });

  it("refresh grant returns a rotated pair with persisted-ready expiry", async () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    vi.useFakeTimers({ now });
    try {
      stubFetch(200, { access_token: "at2", refresh_token: "rt2", expires_in: 7200 });
      expect(await refreshAnthropicTokens("rt1")).toEqual({
        accessToken: "at2",
        refreshToken: "rt2",
        expiresAt: new Date(now + 7200 * 1000 - 5 * 60 * 1000).toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("needsRefresh: legacy pasted setup-tokens (null expiry) never refresh; stored expiry is honored", () => {
    expect(needsRefresh(null)).toBe(false);
    expect(needsRefresh(undefined)).toBe(false);
    expect(needsRefresh("not-a-date")).toBe(false);
    const now = Date.parse("2026-08-12T00:00:00Z");
    expect(needsRefresh(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(needsRefresh(new Date(now + 60_000).toISOString(), now)).toBe(false);
  });

  it("upstream error bodies never reach the thrown message", async () => {
    const { auth_id, authorize_url } = await startOAuth("user_1", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"invalid_grant","secret_detail":"SHOULD-NOT-LEAK"}', { status: 400 })));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = await completeOAuth(auth_id, "user_1", `badcode#${stateOf(authorize_url)}`, KEY).then(() => null, (e: Error) => e);
    logSpy.mockRestore();
    expect(err!.message).toMatch(/token exchange failed \(400\)/);
    expect(err!.message).not.toMatch(/SHOULD-NOT-LEAK/);
  });
});

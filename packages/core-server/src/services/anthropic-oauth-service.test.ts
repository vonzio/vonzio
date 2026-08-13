import { describe, it, expect, vi } from "vitest";
import {
  parseAuthorizationInput,
  buildAuthorizeUrl,
  codeChallengeS256,
  startOAuth,
  completeOAuth,
  refreshAnthropicTokens,
  needsRefresh,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_CODE_REDIRECT_URI,
  ANTHROPIC_OAUTH_TIMEOUT_MS,
  type FetchLike,
} from "./anthropic-oauth-service.js";

const KEY = "unit-test-encryption-key-32chars!";

function okFetch(body: unknown): FetchLike {
  return vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

/** Extract the state param the consent URL carries (what the consent page
 *  will echo back as the `#state` half of the pasted code). */
function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state")!;
}

describe("anthropic-oauth-service", () => {
  it("parses the code#state string the consent page displays", () => {
    expect(parseAuthorizationInput("abc123#st456")).toEqual({ code: "abc123", state: "st456" });
    expect(parseAuthorizationInput("https://console.anthropic.com/oauth/code/callback?code=xyz&state=st")).toEqual({ code: "xyz", state: "st" });
    expect(parseAuthorizationInput("  rawcode  ")).toEqual({ code: "rawcode" });
    expect(parseAuthorizationInput("")).toEqual({});
  });

  it("consent URL never uses '+' for scope spaces (authorize endpoint rejects form-encoding)", () => {
    const { authorize_url } = startOAuth("user_1", KEY);
    expect(authorize_url).not.toContain("+");
    expect(authorize_url).toContain("scope=user%3Ainference");
  });

  it("consent URL: PKCE + display mode, and state is NOT the verifier", () => {
    const { authorize_url } = startOAuth("user_1", KEY);
    const url = new URL(authorize_url);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_CODE_REDIRECT_URI);
    const state = url.searchParams.get("state")!;
    const challenge = url.searchParams.get("code_challenge")!;
    // If state WERE the verifier, its S256 would equal the challenge.
    expect(codeChallengeS256(state)).not.toBe(challenge);
  });

  it("completes a sign-in end to end (sealed auth_id, PKCE verifier sent)", async () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    const { auth_id, authorize_url } = startOAuth("user_1", KEY, now);
    const fetchImpl = okFetch({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const tokens = await completeOAuth(auth_id, "user_1", `thecode#${stateOf(authorize_url)}`, KEY, fetchImpl, now);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBe(new Date(now + 55 * 60 * 1000).toISOString()); // 1h − 5min skew
    const sent = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.grant_type).toBe("authorization_code");
    expect(sent.code).toBe("thecode");
    expect(sent.code_verifier).toBeTruthy();
    expect(sent.code_verifier).not.toBe(sent.state); // verifier never doubles as state
  });

  it("binds the auth token to the initiating user", async () => {
    const { auth_id, authorize_url } = startOAuth("user_1", KEY);
    await expect(
      completeOAuth(auth_id, "user_EVIL", `code#${stateOf(authorize_url)}`, KEY, okFetch({})),
    ).rejects.toThrow(/different user/i);
  });

  it("REQUIRES the state half of the pasted code", async () => {
    const { auth_id } = startOAuth("user_1", KEY);
    await expect(completeOAuth(auth_id, "user_1", "just-a-code", KEY, okFetch({})))
      .rejects.toThrow(/FULL code/i);
  });

  it("rejects a wrong state and a tampered auth token", async () => {
    const { auth_id } = startOAuth("user_1", KEY);
    await expect(completeOAuth(auth_id, "user_1", "code#WRONG", KEY, okFetch({})))
      .rejects.toThrow(/state mismatch/i);
    await expect(completeOAuth("AAAA" + auth_id.slice(4), "user_1", "code#x", KEY, okFetch({})))
      .rejects.toThrow(/invalid/i);
  });

  it("expires the auth token after the TTL", async () => {
    const t0 = Date.parse("2026-08-12T00:00:00Z");
    const { auth_id, authorize_url } = startOAuth("user_1", KEY, t0);
    const later = t0 + ANTHROPIC_OAUTH_TIMEOUT_MS + 1;
    await expect(
      completeOAuth(auth_id, "user_1", `code#${stateOf(authorize_url)}`, KEY, okFetch({}), later),
    ).rejects.toThrow(/expired/i);
  });

  it("refresh grant returns a rotated pair with persisted-ready expiry", async () => {
    const fetchImpl = okFetch({ access_token: "at2", refresh_token: "rt2", expires_in: 7200 });
    const now = Date.parse("2026-08-12T00:00:00Z");
    const tokens = await refreshAnthropicTokens("rt1", fetchImpl, now);
    expect(tokens).toEqual({
      accessToken: "at2",
      refreshToken: "rt2",
      expiresAt: new Date(now + 7200 * 1000 - 5 * 60 * 1000).toISOString(),
    });
  });

  it("needsRefresh: legacy pasted setup-tokens (null expiry) never refresh", () => {
    expect(needsRefresh(null)).toBe(false);
    expect(needsRefresh(undefined)).toBe(false);
    expect(needsRefresh("not-a-date")).toBe(false);
  });

  it("needsRefresh honors the stored expiry", () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    expect(needsRefresh(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(needsRefresh(new Date(now + 60_000).toISOString(), now)).toBe(false);
  });

  it("upstream error bodies never reach the thrown message", async () => {
    const { auth_id, authorize_url } = startOAuth("user_1", KEY);
    const failFetch: FetchLike = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({}),
      text: async () => '{"error":"invalid_grant","secret_detail":"SHOULD-NOT-LEAK"}',
    }));
    const err = await completeOAuth(auth_id, "user_1", `badcode#${stateOf(authorize_url)}`, KEY, failFetch)
      .then(() => null, (e: Error) => e);
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/token exchange failed \(400\)/);
    expect(err!.message).not.toMatch(/SHOULD-NOT-LEAK/);
  });
});

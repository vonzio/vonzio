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
  type FetchLike,
} from "./anthropic-oauth-service.js";

function okFetch(body: unknown): FetchLike {
  return vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

describe("anthropic-oauth-service", () => {
  it("parses the code#state string the consent page displays", () => {
    expect(parseAuthorizationInput("abc123#ver456")).toEqual({ code: "abc123", state: "ver456" });
  });

  it("parses a full redirect URL and a bare code", () => {
    expect(parseAuthorizationInput("https://console.anthropic.com/oauth/code/callback?code=xyz&state=st")).toEqual({ code: "xyz", state: "st" });
    expect(parseAuthorizationInput("  rawcode  ")).toEqual({ code: "rawcode" });
    expect(parseAuthorizationInput("")).toEqual({});
  });

  it("builds the consent URL with PKCE + display mode", () => {
    const url = new URL(buildAuthorizeUrl({ verifier: "ver", codeChallenge: codeChallengeS256("ver") }));
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("ver");
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_CODE_REDIRECT_URI);
  });

  it("completes a sign-in: exchanges the pasted code with the stored verifier", async () => {
    const { auth_id } = startOAuth();
    const fetchImpl = okFetch({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const now = Date.parse("2026-08-12T00:00:00Z");
    const tokens = await completeOAuth(auth_id, "thecode", fetchImpl, now);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    // 1h ttl minus the 5-min skew
    expect(tokens.expiresAt).toBe(new Date(now + 55 * 60 * 1000).toISOString());
    const sent = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.grant_type).toBe("authorization_code");
    expect(sent.code).toBe("thecode");
    expect(sent.code_verifier).toBeTruthy();
  });

  it("rejects a pasted state that doesn't match the stored verifier", async () => {
    const { auth_id } = startOAuth();
    await expect(completeOAuth(auth_id, "code#WRONGSTATE", okFetch({}))).rejects.toThrow(/state mismatch/i);
  });

  it("rejects an unknown/expired auth id", async () => {
    await expect(completeOAuth("nope", "code", okFetch({}))).rejects.toThrow(/expired or unknown/i);
  });

  it("consumes the pending auth on success (no replay)", async () => {
    const { auth_id } = startOAuth();
    const fetchImpl = okFetch({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    await completeOAuth(auth_id, "thecode", fetchImpl);
    await expect(completeOAuth(auth_id, "thecode", fetchImpl)).rejects.toThrow(/expired or unknown/i);
  });

  it("refresh grant returns a rotated pair with persisted-ready expiry", async () => {
    const fetchImpl = okFetch({ access_token: "at2", refresh_token: "rt2", expires_in: 7200 });
    const now = Date.parse("2026-08-12T00:00:00Z");
    const tokens = await refreshAnthropicTokens("rt1", fetchImpl, now);
    expect(tokens).toEqual({
      accessToken: "at2",
      refreshToken: "rt2",
      expiresAt: new Date(now + (7200 * 1000) - 5 * 60 * 1000).toISOString(),
    });
    const sent = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sent.grant_type).toBe("refresh_token");
    expect(sent.refresh_token).toBe("rt1");
  });

  it("needsRefresh: null expiry (legacy pasted setup-token) never refreshes", () => {
    expect(needsRefresh(null)).toBe(false);
    expect(needsRefresh(undefined)).toBe(false);
  });

  it("needsRefresh honors the stored expiry", () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    expect(needsRefresh(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(needsRefresh(new Date(now + 60_000).toISOString(), now)).toBe(false);
    expect(needsRefresh("not-a-date", now)).toBe(false);
  });

  it("surfaces upstream token-endpoint errors with the body", async () => {
    const { auth_id } = startOAuth();
    const failFetch: FetchLike = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({}),
      text: async () => '{"error":"invalid_grant"}',
    }));
    await expect(completeOAuth(auth_id, "badcode", failFetch)).rejects.toThrow(/invalid_grant/);
  });
});

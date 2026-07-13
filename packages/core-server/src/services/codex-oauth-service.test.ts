import { describe, it, expect } from "vitest";
import {
  generateCodeVerifier,
  codeChallengeS256,
  buildAuthorizeUrl,
  parseTokenResponse,
  accountIdFromJwt,
  needsRefresh,
  startDeviceLogin,
  pollDeviceToken,
  refreshTokens,
  CODEX_CLIENT_ID,
  type FetchLike,
} from "./codex-oauth-service.js";

/** Build a fake FetchLike returning a canned JSON body + status. */
function fakeFetch(handler: (url: string, init?: { body?: string }) => { status: number; body: unknown }): {
  fetch: FetchLike;
  calls: Array<{ url: string; body?: string }>;
} {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body });
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch, calls };
}

/** Assemble a fake id_token (header.payload.sig) carrying the account-id claim. */
function fakeIdToken(accountId: string | undefined): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
  const payload = accountId
    ? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } }
    : { sub: "x" };
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("PKCE", () => {
  it("S256 challenge is stable base64url of sha256(verifier)", () => {
    // Known vector from RFC 7636 appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generated verifiers are url-safe and unique", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries the Codex client_id, S256, and a truthful originator by default", () => {
    const url = new URL(buildAuthorizeUrl({ state: "st", codeChallenge: "cc" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("cc");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("originator")).toBe("vonzio");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  });

  it("allows an originator override (self-host parity)", () => {
    const url = new URL(buildAuthorizeUrl({ state: "s", codeChallenge: "c", originator: "codex_cli_rs" }));
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });
});

describe("parseTokenResponse", () => {
  it("maps fields and computes absolute expiry", () => {
    const now = 1_000_000;
    const t = parseTokenResponse(
      { access_token: "at", refresh_token: "rt", id_token: fakeIdToken("acc_1"), expires_in: 600 },
      now,
    );
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
    expect(t.expiresAt).toBe(now + 600_000);
    expect(t.accountId).toBe("acc_1");
  });

  it("defaults expiry when expires_in is missing", () => {
    const t = parseTokenResponse({ access_token: "at", refresh_token: "rt" }, 0);
    expect(t.expiresAt).toBe(900_000);
  });

  it("throws when access_token is absent", () => {
    expect(() => parseTokenResponse({ refresh_token: "rt" })).toThrow(/access_token/);
  });
});

describe("accountIdFromJwt", () => {
  it("decodes the namespaced claim", () => {
    expect(accountIdFromJwt(fakeIdToken("acc_42"))).toBe("acc_42");
  });
  it("returns undefined for a token without the claim", () => {
    expect(accountIdFromJwt(fakeIdToken(undefined))).toBeUndefined();
  });
  it("returns undefined for garbage rather than throwing", () => {
    expect(accountIdFromJwt("not-a-jwt")).toBeUndefined();
    expect(accountIdFromJwt("")).toBeUndefined();
  });
});

describe("needsRefresh", () => {
  it("is true within the skew window and false outside it", () => {
    const now = 1_000_000;
    expect(needsRefresh({ expiresAt: now + 60_000 }, now)).toBe(true); // 1 min left < 5 min skew
    expect(needsRefresh({ expiresAt: now + 10 * 60_000 }, now)).toBe(false); // 10 min left
  });
});

describe("startDeviceLogin", () => {
  it("posts just the client_id and returns device_auth_id + user_code", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { device_auth_id: "dai", user_code: "USER-CODE", interval: 5 },
    }));
    const start = await startDeviceLogin(fetch, 0);
    expect(start.deviceAuthId).toBe("dai");
    expect(start.userCode).toBe("USER-CODE");
    expect(start.verifyUrl).toBe("https://auth.openai.com/codex/device");
    expect(start.expiresAt).toBe(15 * 60 * 1000);
    const body = JSON.parse(calls[0].body!);
    expect(body.client_id).toBe(CODEX_CLIENT_ID);
    expect(body.scope).toBeUndefined();
  });

  it("tolerates a string interval", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { device_auth_id: "dai", user_code: "u", interval: "7" } }));
    expect((await startDeviceLogin(fetch, 0)).intervalSec).toBe(7);
  });

  it("gives a clear error when device login is disabled (404)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: {} }));
    await expect(startDeviceLogin(fetch)).rejects.toThrow(/not enabled/);
  });
});

describe("pollDeviceToken", () => {
  it("treats 403/404 as pending", async () => {
    const { fetch: f403 } = fakeFetch(() => ({ status: 403, body: {} }));
    expect((await pollDeviceToken("dai", "u", f403)).status).toBe("pending");
    const { fetch: f404 } = fakeFetch(() => ({ status: 404, body: {} }));
    expect((await pollDeviceToken("dai", "u", f404)).status).toBe("pending");
  });
  it("maps the nested deviceauth_authorization_pending error → pending", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: { code: "deviceauth_authorization_pending" } } }));
    expect((await pollDeviceToken("dai", "u", fetch)).status).toBe("pending");
  });
  it("maps slow_down → slow_down", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: { code: "slow_down" } } }));
    expect((await pollDeviceToken("dai", "u", fetch)).status).toBe("slow_down");
  });
  it("returns the authorization code + verifier on approval (not tokens)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { authorization_code: "ac", code_verifier: "cv" } }));
    const r = await pollDeviceToken("dai", "u", fetch);
    expect(r.status).toBe("authorized");
    if (r.status === "authorized") {
      expect(r.authorizationCode).toBe("ac");
      expect(r.codeVerifier).toBe("cv");
    }
    const body = JSON.parse(calls[0].body!);
    expect(body.device_auth_id).toBe("dai");
    expect(body.user_code).toBe("u");
  });
  it("surfaces other errors as denied", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: "access_denied" } }));
    const r = await pollDeviceToken("dai", "u", fetch);
    expect(r.status).toBe("denied");
  });
});

describe("refreshTokens", () => {
  it("rotates and returns the new refresh token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { access_token: "at2", refresh_token: "rt2", expires_in: 600 } }));
    const t = await refreshTokens("rt1", fetch, 0);
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("rt2");
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(calls[0].body).toContain("refresh_token=rt1");
  });
  it("keeps the old refresh token when the server omits a new one", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { access_token: "at2", expires_in: 600 } }));
    const t = await refreshTokens("rt1", fetch, 0);
    expect(t.refreshToken).toBe("rt1");
  });
  it("throws on a failed refresh", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: "invalid_grant" } }));
    await expect(refreshTokens("rt1", fetch)).rejects.toThrow(/refresh failed/);
  });
});

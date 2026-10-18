import { describe, it, expect, vi, afterEach } from "vitest";
import {
  codexModels,
  CODEX_MODELS,
  accountIdFromJwt,
  expiryFromAccessToken,
  needsRefresh,
  startDeviceLogin,
  pollDeviceToken,
  exchangeAuthCode,
  refreshTokens,
} from "./codex-oauth-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CODEX_MODELS;
});

/** Stub fetch with a canned status + JSON body; returns the spy. */
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A fake JWT carrying the account-id claim and an exp. */
function fakeJwt(accountId: string | undefined, expSec?: number): string {
  const payload: Record<string, unknown> = accountId ? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } } : { sub: "x" };
  if (expSec) payload.exp = expSec;
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("accountIdFromJwt / expiryFromAccessToken", () => {
  it("decodes the namespaced claim and the exp", () => {
    expect(accountIdFromJwt(fakeJwt("acct_1"))).toBe("acct_1");
    expect(expiryFromAccessToken(fakeJwt("acct_1", 1_800_000_000))).toBe(1_800_000_000_000);
  });
  it("returns undefined / 0 for a token without the claim or for garbage", () => {
    expect(accountIdFromJwt(fakeJwt(undefined))).toBeUndefined();
    expect(accountIdFromJwt("garbage")).toBeUndefined();
    expect(expiryFromAccessToken("garbage")).toBe(0);
  });
});

describe("needsRefresh", () => {
  it("is true within the skew window and false outside it", () => {
    const now = 1_000_000;
    expect(needsRefresh({ expiresAt: now + 4 * 60 * 1000 }, now)).toBe(true);
    expect(needsRefresh({ expiresAt: now + 6 * 60 * 1000 }, now)).toBe(false);
  });
});

describe("startDeviceLogin", () => {
  it("posts just the client_id and returns device_auth_id + user_code", async () => {
    const spy = stubFetch(200, { device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "3" });
    const d = await startDeviceLogin();
    expect(d).toMatchObject({ deviceAuthId: "dev_1", userCode: "ABCD-EFGH", intervalSec: 3 });
    expect(d.verifyUrl).toMatch(/^https:\/\/auth\.openai\.com\//);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/deviceauth\/usercode$/);
    expect(Object.keys(JSON.parse(String(init.body)) as object)).toEqual(["client_id"]);
  });

  it("gives a clear error when device login is disabled (404)", async () => {
    stubFetch(404, {});
    await expect(startDeviceLogin()).rejects.toThrow(/not enabled/i);
  });
});

describe("pollDeviceToken", () => {
  it("treats 403/404 as pending, maps slow_down, returns code + verifier on approval", async () => {
    stubFetch(403, {});
    expect(await pollDeviceToken("d", "u")).toEqual({ status: "pending" });
    stubFetch(400, { error: { code: "deviceauth_authorization_pending" } });
    expect(await pollDeviceToken("d", "u")).toEqual({ status: "pending" });
    stubFetch(400, { error: "slow_down" });
    expect(await pollDeviceToken("d", "u")).toEqual({ status: "slow_down" });
    stubFetch(200, { authorization_code: "ac", code_verifier: "cv" });
    expect(await pollDeviceToken("d", "u")).toEqual({ status: "authorized", authorizationCode: "ac", codeVerifier: "cv" });
  });

  it("surfaces other errors as denied", async () => {
    stubFetch(400, { error: "access_denied" });
    expect((await pollDeviceToken("d", "u")).status).toBe("denied");
  });
});

describe("exchangeAuthCode / refreshTokens", () => {
  it("exchanges at the device redirect and decodes the account id", async () => {
    const spy = stubFetch(200, { access_token: fakeJwt("acct_9", 2_000_000_000), refresh_token: "rt" });
    const t = await exchangeAuthCode({ code: "ac", codeVerifier: "cv" });
    expect(t.accountId).toBe("acct_9");
    expect(t.refreshToken).toBe("rt");
    expect(t.expiresAt).toBe(2_000_000_000_000);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("redirect_uri")).toMatch(/deviceauth\/callback$/);
  });

  it("rotates, keeps the old refresh token when the server omits one, and throws on failure", async () => {
    stubFetch(200, { access_token: fakeJwt("a", 2_000_000_000), refresh_token: "rt2" });
    expect((await refreshTokens("rt1")).refreshToken).toBe("rt2");
    stubFetch(200, { access_token: fakeJwt("a", 2_000_000_000) });
    expect((await refreshTokens("rt1")).refreshToken).toBe("rt1");
    stubFetch(401, { error: "invalid_grant" });
    await expect(refreshTokens("rt1")).rejects.toThrow(/401/);
  });
});

describe("codexModels (env override)", () => {
  it("returns the baked default when unset and parses an override", () => {
    expect(codexModels()).toEqual([...CODEX_MODELS]);
    process.env.CODEX_MODELS = "gpt-9, gpt-9-mini";
    expect(codexModels()).toEqual(["gpt-9", "gpt-9-mini"]);
    process.env.CODEX_MODELS = "  ";
    expect(codexModels()).toEqual([...CODEX_MODELS]);
  });
});

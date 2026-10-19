import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OPENCODE_CLIENT_ID,
  needsRefresh,
  pollDeviceToken,
  refreshTokens,
  startDeviceLogin,
} from "./opencode-oauth-service.js";

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with a canned status + JSON body; returns the spy. */
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const sentBody = (spy: ReturnType<typeof stubFetch>) => {
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe("startDeviceLogin", () => {
  it("starts the device grant under vonzio's client id", async () => {
    const spy = stubFetch(200, {
      device_code: "dc_1",
      user_code: "ABCD-1234",
      verification_uri_complete: "https://opencode.ai/console/device?code=ABCD-1234",
      expires_in: 600,
      interval: 5,
    });
    const d = await startDeviceLogin();
    expect(d).toMatchObject({ deviceCode: "dc_1", userCode: "ABCD-1234", intervalSec: 5 });
    expect(d.verifyUrl).toBe("https://opencode.ai/console/device?code=ABCD-1234");
    const { url, body } = sentBody(spy);
    expect(url).toBe("https://opencode.ai/console/auth/device/code");
    expect(body.client_id).toBe(OPENCODE_CLIENT_ID);
    expect(OPENCODE_CLIENT_ID).toBe("vonzio");
  });

  it("throws on an upstream failure", async () => {
    stubFetch(500, { error: "boom" });
    await expect(startDeviceLogin()).rejects.toThrow(/500/);
  });
});

describe("pollDeviceToken", () => {
  it("keeps going while authorization is pending or slowed down", async () => {
    stubFetch(400, { error: "authorization_pending" });
    expect(await pollDeviceToken("dc_1")).toEqual({ status: "pending" });
    stubFetch(400, { error: "slow_down" });
    expect(await pollDeviceToken("dc_1")).toEqual({ status: "slow_down" });
  });

  it("returns the stored token shape on approval: ISO refresh threshold and org", async () => {
    const now = Date.now();
    const spy = stubFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 30 * 24 * 3600, org_id: "org_1" });
    const poll = await pollDeviceToken("dc_1");
    expect(poll.status).toBe("authorized");
    if (poll.status !== "authorized") return;
    expect(poll.tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", orgId: "org_1" });
    const at = new Date(poll.tokens.expiresAt).getTime();
    // 30 days minus the 5-minute refresh skew.
    expect(at).toBeGreaterThan(now + 30 * 24 * 3600 * 1000 - 6 * 60 * 1000);
    expect(at).toBeLessThan(now + 30 * 24 * 3600 * 1000);
    const { body } = sentBody(spy);
    expect(body).toMatchObject({ device_code: "dc_1", client_id: "vonzio" });
  });

  it("reports a denial in words", async () => {
    stubFetch(400, { error: "access_denied" });
    const poll = await pollDeviceToken("dc_1");
    expect(poll).toMatchObject({ status: "denied" });
  });
});

describe("refreshTokens", () => {
  it("rotates the pair under vonzio's client id, keeping the refresh token when none comes back", async () => {
    const spy = stubFetch(200, { access_token: "at2", expires_in: 3600 });
    const t = await refreshTokens("rt");
    expect(t).toMatchObject({ accessToken: "at2", refreshToken: "rt" });
    expect(t).not.toHaveProperty("orgId");
    expect(sentBody(spy).body).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt", client_id: "vonzio" });
  });

  it("says a revoked session needs a new sign-in", async () => {
    stubFetch(400, { error: "invalid_grant" });
    await expect(refreshTokens("rt")).rejects.toThrow(/sign in again/);
  });
});

describe("needsRefresh", () => {
  it("compares the stored threshold with now, refreshing when it is unknown", () => {
    const now = 1_000_000;
    expect(needsRefresh(new Date(now + 1000).toISOString(), now)).toBe(false);
    expect(needsRefresh(new Date(now - 1000).toISOString(), now)).toBe(true);
    expect(needsRefresh(null, now)).toBe(true);
    expect(needsRefresh("garbage", now)).toBe(true);
  });
});

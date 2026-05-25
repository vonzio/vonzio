import { describe, it, expect } from "vitest";
import { TellerClient, TellerNotConfiguredError } from "./teller-client.js";
import type { Config } from "../config.js";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    TELLER_API_BASE: "https://api.teller.io",
    TELLER_APP_ID: undefined,
    TELLER_CERT_PATH: undefined,
    TELLER_KEY_PATH: undefined,
    TELLER_SIGNING_PUBKEY: undefined,
    ...over,
  } as unknown as Config;
}

describe("TellerClient", () => {
  it("isConfigured() is false when cert or key path missing", () => {
    expect(new TellerClient(makeConfig()).isConfigured()).toBe(false);
    expect(new TellerClient(makeConfig({ TELLER_CERT_PATH: "/x" })).isConfigured()).toBe(false);
    expect(new TellerClient(makeConfig({ TELLER_KEY_PATH: "/x" })).isConfigured()).toBe(false);
  });

  it("isConfigured() is true when both paths set", () => {
    expect(
      new TellerClient(
        makeConfig({ TELLER_CERT_PATH: "/x/cert.pem", TELLER_KEY_PATH: "/x/key.pem" }),
      ).isConfigured(),
    ).toBe(true);
  });

  it("listAccounts throws TellerNotConfiguredError when not wired", async () => {
    const c = new TellerClient(makeConfig());
    await expect(c.listAccounts("token_x")).rejects.toBeInstanceOf(TellerNotConfiguredError);
  });
});

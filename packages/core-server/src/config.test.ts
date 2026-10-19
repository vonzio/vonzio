import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  BETTER_AUTH_SECRET: "a]Kz#mR9!pL$2wF&vQ8nX5bJ@cY7hT4d",
  ENCRYPTION_KEY: "a]Kz#mR9!pL$2wF&vQ8nX5bJ@cY7hT4d",
};

describe("loadConfig", () => {
  it("loads defaults when only required vars are set", () => {
    const config = loadConfig(validEnv);

    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_URL).toBe("postgres://vonzio:vonzio_dev@localhost:5432/vonzio");
    expect(config.MAX_CONCURRENT_AGENTS).toBe(4);
    expect(config.POOL_MIN_SIZE).toBe(3);
    expect(config.POOL_MAX_SIZE).toBe(10);
    expect(config.SESSION_IDLE_TTL_SECS).toBe(14400);
    expect(config.SESSION_IDLE_PAUSE_SECS).toBe(900);
    expect(config.RATE_LIMIT_CALLER_RPM).toBe(60);
    expect(config.CONTAINER_MEMORY_LIMIT_BATCH).toBe("1g");
    expect(config.CONTAINER_MEMORY_LIMIT_SESSION).toBe("4g");
    expect(config.PROMETHEUS_ENABLED).toBe(false);
  });

  it("overrides defaults with provided values", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "4000",
      MAX_CONCURRENT_AGENTS: "8",
      POOL_MIN_SIZE: "5",
      PROMETHEUS_ENABLED: "true",
    });

    expect(config.PORT).toBe(4000);
    expect(config.MAX_CONCURRENT_AGENTS).toBe(8);
    expect(config.POOL_MIN_SIZE).toBe(5);
    expect(config.PROMETHEUS_ENABLED).toBe(true);
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "a]Kz#mR9!pL$2wF&vQ8nX5bJ@cY7hT4d" })).toThrow(
      "Invalid configuration",
    );
  });

  it("throws when ENCRYPTION_KEY is too short", () => {
    expect(() =>
      loadConfig({ ENCRYPTION_KEY: "short", BETTER_AUTH_SECRET: "a]Kz#mR9!pL$2wF&vQ8nX5bJ@cY7hT4d" }),
    ).toThrow("ENCRYPTION_KEY must be at least 32 characters");
  });

  it("throws when BETTER_AUTH_SECRET is missing", () => {
    expect(() =>
      loadConfig({
        ENCRYPTION_KEY: "a]Kz#mR9!pL$2wF&vQ8nX5bJ@cY7hT4d",
      }),
    ).toThrow("Invalid configuration");
  });

  describe("egress enforcement", () => {
    it("is ON by default with the built-in allowlist and no extra hosts", () => {
      const config = loadConfig(validEnv);
      expect(config.EGRESS_ENFORCEMENT).toBe(true);
      expect(config.EGRESS_BUILTIN_ALLOWLIST).toBe(true);
      expect(config.EGRESS_ALLOWED_HOSTS).toBe("");
      expect(config.EGRESS_PROXY_NETWORK).toBe("vonzio-egress");
    });

    it.each(["0", "false", "off", "no", ""])("opts out with EGRESS_ENFORCEMENT=%j", (v) => {
      expect(loadConfig({ ...validEnv, EGRESS_ENFORCEMENT: v }).EGRESS_ENFORCEMENT).toBe(false);
    });

    it.each(["1", "true", "on"])("stays on with EGRESS_ENFORCEMENT=%j", (v) => {
      expect(loadConfig({ ...validEnv, EGRESS_ENFORCEMENT: v }).EGRESS_ENFORCEMENT).toBe(true);
    });

    it("drops the built-in allowlist only on an explicit false", () => {
      expect(loadConfig({ ...validEnv, EGRESS_BUILTIN_ALLOWLIST: "false" }).EGRESS_BUILTIN_ALLOWLIST).toBe(false);
      expect(loadConfig({ ...validEnv, EGRESS_BUILTIN_ALLOWLIST: "" }).EGRESS_BUILTIN_ALLOWLIST).toBe(true);
    });
  });
});

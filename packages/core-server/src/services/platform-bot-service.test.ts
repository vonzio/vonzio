import { describe, it, expect, vi } from "vitest";
import { PlatformBotService } from "./platform-bot-service.js";
import type { Config } from "../config.js";
import type { TelegramService } from "./telegram-service.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    BETTER_AUTH_URL: "https://app.vonz.io",
    PLATFORM_TELEGRAM_BOT_TOKEN: undefined,
    PLATFORM_TELEGRAM_WEBHOOK_SECRET: undefined,
    ...overrides,
  } as unknown as Config;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("PlatformBotService", () => {
  it("is disabled when env vars are unset", async () => {
    const tg = { getMe: vi.fn(), setWebhook: vi.fn() } as unknown as TelegramService;
    const svc = new PlatformBotService(makeConfig(), tg, makeLog());
    expect(svc.isConfigured()).toBe(false);
    await svc.init();
    expect(svc.getMetadata()).toBeNull();
    expect(tg.getMe).not.toHaveBeenCalled();
    expect(tg.setWebhook).not.toHaveBeenCalled();
  });

  it("validates token and registers webhook on init", async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 12345, is_bot: true, username: "vonzio_test_bot", first_name: "Vonzio" });
    const setWebhook = vi.fn().mockResolvedValue(undefined);
    const tg = { getMe, setWebhook } as unknown as TelegramService;
    const cfg = makeConfig({
      PLATFORM_TELEGRAM_BOT_TOKEN: "12345:abcDEF",
      PLATFORM_TELEGRAM_WEBHOOK_SECRET: "secret-xyz",
    });
    const svc = new PlatformBotService(cfg, tg, makeLog());
    await svc.init();
    expect(svc.getMetadata()).toEqual({ botUserId: "12345", botUsername: "vonzio_test_bot" });
    expect(setWebhook).toHaveBeenCalledWith(
      "12345:abcDEF",
      "https://app.vonz.io/api/telegram/webhook/12345",
      "secret-xyz",
    );
  });

  it("init is idempotent — second call no-ops", async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 1, is_bot: true, username: "x", first_name: "x" });
    const setWebhook = vi.fn().mockResolvedValue(undefined);
    const tg = { getMe, setWebhook } as unknown as TelegramService;
    const cfg = makeConfig({ PLATFORM_TELEGRAM_BOT_TOKEN: "1:abc", PLATFORM_TELEGRAM_WEBHOOK_SECRET: "s" });
    const svc = new PlatformBotService(cfg, tg, makeLog());
    await svc.init();
    await svc.init();
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it("disables itself when getMe rejects (no throw)", async () => {
    const tg = {
      getMe: vi.fn().mockRejectedValue(new Error("Unauthorized")),
      setWebhook: vi.fn(),
    } as unknown as TelegramService;
    const log = makeLog();
    const cfg = makeConfig({ PLATFORM_TELEGRAM_BOT_TOKEN: "bad", PLATFORM_TELEGRAM_WEBHOOK_SECRET: "s" });
    const svc = new PlatformBotService(cfg, tg, log);
    await svc.init();
    expect(svc.getMetadata()).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("disables itself when the token belongs to a non-bot account", async () => {
    const tg = {
      getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: false, username: "person", first_name: "x" }),
      setWebhook: vi.fn(),
    } as unknown as TelegramService;
    const cfg = makeConfig({ PLATFORM_TELEGRAM_BOT_TOKEN: "1:abc", PLATFORM_TELEGRAM_WEBHOOK_SECRET: "s" });
    const svc = new PlatformBotService(cfg, tg, makeLog());
    await svc.init();
    expect(svc.getMetadata()).toBeNull();
    expect(tg.setWebhook).not.toHaveBeenCalled();
  });

  it("getToken always reads from config (rotation is single env change)", () => {
    const cfg = makeConfig({ PLATFORM_TELEGRAM_BOT_TOKEN: "old-token", PLATFORM_TELEGRAM_WEBHOOK_SECRET: "s" });
    const svc = new PlatformBotService(cfg, {} as TelegramService, makeLog());
    expect(svc.getToken()).toBe("old-token");
    // Rotating in-place:
    (cfg as { PLATFORM_TELEGRAM_BOT_TOKEN?: string }).PLATFORM_TELEGRAM_BOT_TOKEN = "new-token";
    expect(svc.getToken()).toBe("new-token");
  });
});

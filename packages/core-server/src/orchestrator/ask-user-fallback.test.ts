import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAskUserFallback } from "./ask-user-fallback.js";
import { SessionPresenceRegistry } from "../lib/session-presence.js";
import type { NotificationService } from "../services/notification-service.js";
import type { SessionRegistry } from "../container/session-registry.js";

/**
 * After the SessionPresenceRegistry inversion the fallback no longer
 * reads telegram_sessions / slack_thread_mappings or
 * integrationService directly -- it walks registered providers. The
 * tests drive that surface by registering ad-hoc providers that mimic
 * what the telegram/slack plugins would do at runtime.
 */

function makeFallback(opts: {
  liveDashboardSessions?: string[];
  telegramSessions?: Array<{ session_id: string; user_id: string }>;
  slackSessions?: string[];
  workspaceUserId?: string | null;
  /**
   * Telegram bots returned by the telegram provider's
   * hasOwnerSurface() for the workspace owner. Used to test the
   * "wider in-band surface" check that suppresses the plain-text
   * fallback when the user has a LINKED bot.
   */
  userTelegramBots?: Array<{ linked: boolean }>;
}) {
  const liveDashboard = new Set(opts.liveDashboardSessions ?? []);
  const telegramRows = opts.telegramSessions ?? [];
  const slackRows = opts.slackSessions ?? [];

  // Stand in for the SessionRegistry's narrow surface that the
  // fallback actually uses.
  const sessionRegistry = {
    getConnectedSessionIds: () => liveDashboard,
    get: (_id: string) =>
      opts.workspaceUserId !== undefined
        ? (opts.workspaceUserId === null ? null : { user_id: opts.workspaceUserId })
        : null,
  } as unknown as SessionRegistry;

  // Build a real registry and register two mock providers. This
  // exercises the same code path the runtime takes -- the loader
  // builds the same registry and the telegram plugin / builtin slack
  // do exactly this kind of registration at init().
  const sessionPresence = new SessionPresenceRegistry();
  sessionPresence.register({
    surface: "telegram",
    metadata: { label: "Telegram", slow: true },
    hasSession: async (sid) => telegramRows.some((r) => r.session_id === sid),
    hasOwnerSurface: async (_userId) =>
      (opts.userTelegramBots ?? []).some((b) => b.linked),
    resolveUserIdBySession: async (sid) => telegramRows.find((r) => r.session_id === sid)?.user_id ?? null,
  });
  sessionPresence.register({
    surface: "slack",
    metadata: { label: "Slack", slow: true },
    hasSession: async (sid) => slackRows.includes(sid),
  });

  const send = vi.fn(async () => ({ success: true, channel: "telegram" }));
  const notificationService = { send } as unknown as NotificationService;

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child() { return log; } } as ReturnType<
    typeof vi.fn extends (...args: infer _) => infer _R ? () => unknown : never
  > as unknown as Parameters<typeof createAskUserFallback>[0]["log"];

  const handler = createAskUserFallback({
    sessionRegistry,
    notificationService,
    sessionPresence,
    dashboardUrl: "https://app.vonz.io",
    log,
  });

  return { handler, send };
}

const SAMPLE_INPUT = {
  questions: [{ question: "Which database backend should I use?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
};

describe("createAskUserFallback", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("skips notification when a dashboard WS is live for the session", async () => {
    const { handler, send } = makeFallback({
      liveDashboardSessions: ["sess-1"],
      workspaceUserId: "user-1",
    });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("skips notification when a telegram presence provider reports the session as bound", async () => {
    const { handler, send } = makeFallback({
      telegramSessions: [{ session_id: "sess-1", user_id: "user-1" }],
      workspaceUserId: "user-1",
    });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends notification when no surface is reachable", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).toHaveBeenCalledTimes(1);
    const call = (send.mock.calls as unknown as Array<[{ userId: string; urgency: string; source: string; taskId: string; message: string }]>)[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.urgency).toBe("high");
    expect(call.source).toBe("agent");
    expect(call.taskId).toBe("task-1");
    expect(call.message).toContain("Which database backend should I use?");
    expect(call.message).toContain("https://app.vonz.io/w/sess-1");
  });

  it("falls back to provider.resolveUserIdBySession when sessionRegistry has no workspace", async () => {
    // sessionRegistry returns null; without a resolvable user_id we
    // can't deliver -- this asserts the resolver still does NOT send
    // when no provider has the binding either (negative path).
    const { handler, send } = makeFallback({
      telegramSessions: [],
      workspaceUserId: null,
    });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("dedupes the same question for the same task inside the TTL", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe across different tasks (different agent runs may both legitimately need to notify)", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    await handler("task-2", "sess-1", SAMPLE_INPUT);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe different questions for the same task", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    await handler("task-1", "sess-1", {
      questions: [{ question: "Different question?", options: [{ label: "Yes" }] }],
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips one-shot tasks (no session_id)", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", undefined, SAMPLE_INPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("handles malformed input gracefully", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    await handler("task-1", "sess-1", null);
    expect(send).toHaveBeenCalledTimes(1);
    const call = (send.mock.calls as unknown as Array<[{ userId: string; urgency: string; source: string; taskId: string; message: string }]>)[0][0];
    expect(call.message).toContain("The agent needs your input");
  });

  it("skips notification when a provider reports an owner-surface (e.g. linked Telegram bot DM)", async () => {
    // Dashboard-origin session (no telegram chat binding) but the user
    // has a linked Telegram bot. The Telegram ask_user relay will now
    // send an inline-keyboard question to the user's DM, so the
    // fallback must NOT also fire -- would be a double-notification.
    const { handler, send } = makeFallback({
      workspaceUserId: "user-1",
      userTelegramBots: [{ linked: true }],
    });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).not.toHaveBeenCalled();
  });

  it("still notifies when the user's only Telegram bot is UNLINKED (no in-band delivery possible)", async () => {
    // The user clicked "Connect Telegram" but never finished the /start
    // pairing -- no owner_tg_user_id on the integration. The in-band
    // relay has nothing to DM, so the fallback should fire.
    const { handler, send } = makeFallback({
      workspaceUserId: "user-1",
      userTelegramBots: [{ linked: false }],
    });
    await handler("task-1", "sess-1", SAMPLE_INPUT);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("truncates long question text in the notification summary", async () => {
    const { handler, send } = makeFallback({ workspaceUserId: "user-1" });
    const longQuestion = "x".repeat(500);
    await handler("task-1", "sess-1", { questions: [{ question: longQuestion }] });
    const call = (send.mock.calls as unknown as Array<[{ userId: string; urgency: string; source: string; taskId: string; message: string }]>)[0][0];
    expect(call.message).toContain("...");
    // 240-char cap + "..." + the surrounding lines; assert the cap fired.
    expect((call.message.match(/x+/) ?? [""])[0].length).toBeLessThanOrEqual(240);
  });
});

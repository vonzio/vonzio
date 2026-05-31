import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { parsePluginEnvList, buildSessionEventsFacade } from "./loader.js";
import { NotificationBusImpl } from "./notification-bus.js";
import { McpRegistryImpl } from "./mcp-registry.js";
import { SchedulerImpl } from "./scheduler.js";

describe("parsePluginEnvList", () => {
  it("returns [] for empty input", () => {
    expect(parsePluginEnvList(undefined)).toEqual([]);
    expect(parsePluginEnvList(null)).toEqual([]);
    expect(parsePluginEnvList("")).toEqual([]);
    expect(parsePluginEnvList("   ")).toEqual([]);
  });

  it("parses a single scoped package", () => {
    expect(parsePluginEnvList("@vonzio/plugin-telegram")).toEqual([
      { packageName: "@vonzio/plugin-telegram" },
    ]);
  });

  it("strips version constraint from scoped package", () => {
    expect(parsePluginEnvList("@vonzio/plugin-telegram@^0.1")).toEqual([
      { packageName: "@vonzio/plugin-telegram" },
    ]);
    expect(parsePluginEnvList("@vonzio/plugin-slack@1.2.3")).toEqual([
      { packageName: "@vonzio/plugin-slack" },
    ]);
  });

  it("parses bare (unscoped) package", () => {
    expect(parsePluginEnvList("my-plugin")).toEqual([{ packageName: "my-plugin" }]);
    expect(parsePluginEnvList("my-plugin@^1.0")).toEqual([{ packageName: "my-plugin" }]);
  });

  it("parses multiple entries with whitespace + trailing comma", () => {
    expect(
      parsePluginEnvList("@vonzio/plugin-telegram@^0.1, @vonzio/plugin-slack, my-plugin@1.0,"),
    ).toEqual([
      { packageName: "@vonzio/plugin-telegram" },
      { packageName: "@vonzio/plugin-slack" },
      { packageName: "my-plugin" },
    ]);
  });
});

describe("NotificationBusImpl", () => {
  it("dispatches to the handler that claimed the kind", async () => {
    const bus = new NotificationBusImpl();
    bus.registerHandler("telegram", async (req) => {
      expect(req.text).toBe("hello");
      return { ok: true };
    });
    const result = await bus.dispatch({ kind: "telegram", recipient: "u1", text: "hello" });
    expect(result).toEqual({ ok: true });
  });

  it("returns synthetic failure when no handler claims the kind", async () => {
    const bus = new NotificationBusImpl();
    const result = await bus.dispatch({ kind: "nope", recipient: "u1", text: "x" });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("wraps handler exceptions as non-retryable failures", async () => {
    const bus = new NotificationBusImpl();
    bus.registerHandler("flaky", async () => {
      throw new Error("upstream down");
    });
    const result = await bus.dispatch({ kind: "flaky", recipient: "u1", text: "x" });
    expect(result).toEqual({ ok: false, error: "upstream down", retryable: false });
  });

  it("rejects double-registration of the same kind", () => {
    const bus = new NotificationBusImpl();
    bus.registerHandler("telegram", async () => ({ ok: true }));
    expect(() => bus.registerHandler("telegram", async () => ({ ok: true }))).toThrow(/already registered/);
  });

  it("rejects empty/non-string kind", () => {
    const bus = new NotificationBusImpl();
    expect(() => bus.registerHandler("", async () => ({ ok: true }))).toThrow(/non-empty/);
  });
});

describe("McpRegistryImpl", () => {
  it("records registered servers in list()", () => {
    const reg = new McpRegistryImpl();
    reg.registerServer({ name: "gmail", transport: { type: "http", url: "https://x" } });
    reg.registerServer({ name: "teller", transport: { type: "stdio", command: "node", args: ["t.js"] } });
    expect(reg.list().map((s) => s.name).sort()).toEqual(["gmail", "teller"]);
  });

  it("rejects double-registration of the same name", () => {
    const reg = new McpRegistryImpl();
    reg.registerServer({ name: "x", transport: { type: "http", url: "http://x" } });
    expect(() =>
      reg.registerServer({ name: "x", transport: { type: "http", url: "http://y" } }),
    ).toThrow(/already registered/);
  });
});

describe("SchedulerImpl", () => {
  it("runs interval jobs at the configured rate", async () => {
    const sched = new SchedulerImpl();
    let count = 0;
    sched.interval("t", 5, async () => {
      count += 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    sched.stopAll();
    expect(count).toBeGreaterThan(2);
  });

  it("rejects double-registration of the same job name", () => {
    const sched = new SchedulerImpl();
    sched.interval("t", 1000, async () => {});
    expect(() => sched.interval("t", 1000, async () => {})).toThrow(/already registered/);
    sched.stopAll();
  });

  it("rejects invalid intervals", () => {
    const sched = new SchedulerImpl();
    expect(() => sched.interval("t", 0, async () => {})).toThrow(/> 0/);
    expect(() => sched.interval("t", -1, async () => {})).toThrow(/> 0/);
    expect(() => sched.interval("t", Infinity, async () => {})).toThrow(/> 0/);
  });

  it("stopAll cancels all jobs", async () => {
    const sched = new SchedulerImpl();
    let count = 0;
    sched.interval("a", 5, async () => {
      count += 1;
    });
    sched.interval("b", 5, async () => {
      count += 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    const countAfterRun = count;
    sched.stopAll();
    await new Promise((r) => setTimeout(r, 30));
    // No further increments after stopAll (within a small race window).
    expect(count).toBeLessThanOrEqual(countAfterRun + 2);
  });

  it("cron() throws (not yet implemented)", () => {
    const sched = new SchedulerImpl();
    expect(() => sched.cron("x", "* * * * *", async () => {})).toThrow(/not implemented/);
  });

  it("interval continues after a fn throws", async () => {
    const sched = new SchedulerImpl();
    let ok = 0;
    let bad = 0;
    sched.interval("flaky", 5, async () => {
      bad += 1;
      if (bad < 3) throw new Error("intentional");
      ok += 1;
    });
    await new Promise((r) => setTimeout(r, 50));
    sched.stopAll();
    expect(ok).toBeGreaterThanOrEqual(1);
  });
});

describe("buildSessionEventsFacade", () => {
  it("forwards on() to the underlying emitter and delivers events", () => {
    const emitter = new EventEmitter();
    const facade = buildSessionEventsFacade(emitter);
    const received: Array<[string, string | undefined, string]> = [];
    facade.on("task:token", (taskId, sessionId, text) => {
      received.push([taskId, sessionId, text]);
    });
    emitter.emit("task:token", "t1", "s1", "hello");
    emitter.emit("task:token", "t2", undefined, "world");
    expect(received).toEqual([
      ["t1", "s1", "hello"],
      ["t2", undefined, "world"],
    ]);
  });

  it("off() unsubscribes a previously registered handler", () => {
    const emitter = new EventEmitter();
    const facade = buildSessionEventsFacade(emitter);
    let count = 0;
    const handler = () => {
      count += 1;
    };
    facade.on("task:done", handler);
    emitter.emit("task:done", "t1", "s1", { text: "ok" });
    expect(count).toBe(1);
    facade.off("task:done", handler);
    emitter.emit("task:done", "t2", "s2", { text: "ok again" });
    expect(count).toBe(1);
  });

  it("is a silent no-op when no emitter is provided", () => {
    const facade = buildSessionEventsFacade(undefined);
    // Subscribing + unsubscribing should not throw; events from nowhere
    // simply don't reach the handler.
    let fired = false;
    facade.on("task:failed", () => {
      fired = true;
    });
    facade.off("task:failed", () => {});
    expect(fired).toBe(false);
  });

  it("supports independent multi-event subscription on the same emitter", () => {
    const emitter = new EventEmitter();
    const facade = buildSessionEventsFacade(emitter);
    const events: string[] = [];
    // Wrap each handler so its body returns `void` (events.push() returns
    // the array length, which the typed overloads of `on()` reject because
    // `task:done` / `task:failed` are async-capable signatures that demand
    // `void | Promise<void>`, not `number`).
    facade.on("task:token", () => {
      events.push("token");
    });
    facade.on("task:done", () => {
      events.push("done");
    });
    facade.on("task:failed", () => {
      events.push("failed");
    });
    emitter.emit("task:token", "t", "s", "x");
    emitter.emit("task:done", "t", "s", { text: "ok" });
    emitter.emit("task:failed", "t", "s", "boom");
    expect(events).toEqual(["token", "done", "failed"]);
  });
});

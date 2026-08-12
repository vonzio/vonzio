import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry.js";
import type { DrizzleDB } from "../db/index.js";

// DB-INDEPENDENT sweep tests (issue #333 pause-on-idle). The SessionRegistry
// suite in container.test.ts needs a real Postgres (createTestDB), which CI
// can't provide yet (the documented v0.1.0 limitation: dropping the schema
// wipes the Better Auth tables migration 9 alters). The sweep logic itself
// only *writes* through drizzle and never reads back, so a chainable,
// awaitable fake keeps these tests runnable everywhere — including the CI
// unit-test subset.

/** Chainable + awaitable drizzle stand-in: every method returns the proxy,
 *  awaiting it resolves to []. */
function fakeDb(): DrizzleDB {
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown[]) => void) => resolve([]);
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy as DrizzleDB;
}

const sweepConfig = {
  idleTtlSecs: 100,
  sessionIdlePauseSecs: 60,
  maxLifetimeSecs: 86400,
  workstationIdlePauseSecs: 100,
  workstationMaxLifetimeSecs: 604800,
  maxPaused: 10,
  volumeTtlDays: 7,
};

function makeRegistry(overrides: Partial<typeof sweepConfig> = {}) {
  const callbacks = {
    onIdleExpiry: vi.fn(),
    onIdlePause: vi.fn(),
    onExpired: vi.fn(),
  };
  const registry = new SessionRegistry(
    { ...sweepConfig, ...overrides },
    callbacks,
    fakeDb(),
  );
  return { registry, callbacks };
}

const agoIso = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
const runSweep = (registry: SessionRegistry) =>
  (registry as unknown as { sweep: () => Promise<void> }).sweep();

describe("SessionRegistry idle sweep (#333 pause-on-idle)", () => {
  it("pauses a non-persistent session idle past sessionIdlePauseSecs", async () => {
    const { registry, callbacks } = makeRegistry();
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80); // 60 < 80 < 100

    await runSweep(registry);

    expect(callbacks.onIdlePause).toHaveBeenCalledWith("sess_1", "ctr_1");
    expect(registry.get("sess_1")!.status).toBe("paused");
    // container_id must survive a pause — the pool's orphan sweep reaps any
    // container whose session link disappears from memory + DB.
    expect(registry.get("sess_1")!.container_id).toBe("ctr_1");
  });

  it("does not pause when sessionIdlePauseSecs is 0 (disabled)", async () => {
    const { registry, callbacks } = makeRegistry({ sessionIdlePauseSecs: 0 });
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80);

    await runSweep(registry);

    expect(callbacks.onIdlePause).not.toHaveBeenCalled();
    expect(registry.get("sess_1")!.status).toBe("active");
  });

  it("does not pause a session with a live WS connection", async () => {
    const { registry, callbacks } = makeRegistry();
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80);
    registry.getConnectedSessionIds = () => new Set(["sess_1"]);

    await runSweep(registry);

    expect(callbacks.onIdlePause).not.toHaveBeenCalled();
    expect(registry.get("sess_1")!.status).toBe("active");
  });

  it("does not pause sessions the injected predicate exempts (playbooks / active tasks)", async () => {
    const { registry, callbacks } = makeRegistry();
    await registry.register("pb-chain1", "ctr_pb", "user_1", "prof_1");
    registry.get("pb-chain1")!.last_active_at = agoIso(80);
    registry.isSessionPausable = (id) => !id.startsWith("pb-");

    await runSweep(registry);

    expect(callbacks.onIdlePause).not.toHaveBeenCalled();
    expect(registry.get("pb-chain1")!.status).toBe("active");
  });

  it("tears down a PAUSED non-persistent session at the idle TTL", async () => {
    const { registry, callbacks } = makeRegistry();
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80);
    await runSweep(registry); // → paused
    expect(registry.get("sess_1")!.status).toBe("paused");

    registry.get("sess_1")!.last_active_at = agoIso(150); // past idleTtlSecs=100
    await runSweep(registry);

    expect(callbacks.onIdleExpiry).toHaveBeenCalledWith("sess_1", "ctr_1");
    expect(registry.get("sess_1")!.status).toBe("resumable");
    expect(registry.get("sess_1")!.container_id).toBeNull();
  });

  it("keeps the session active when the pause callback fails", async () => {
    const { registry, callbacks } = makeRegistry();
    callbacks.onIdlePause.mockRejectedValueOnce(new Error("docker pause failed"));
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80);

    await runSweep(registry);

    expect(registry.get("sess_1")!.status).toBe("active");
    expect(registry.get("sess_1")!.container_id).toBe("ctr_1");
  });

  it("updateActivity resumes a paused session to active", async () => {
    const { registry } = makeRegistry();
    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    registry.get("sess_1")!.last_active_at = agoIso(80);
    await runSweep(registry);
    expect(registry.get("sess_1")!.status).toBe("paused");

    await registry.updateActivity("sess_1");
    expect(registry.get("sess_1")!.status).toBe("active");
  });

  it("persistent sessions still pause on the workstation window, not the chat window", async () => {
    const { registry, callbacks } = makeRegistry();
    await registry.register("sess_ws", "ctr_ws", "user_1", "prof_1", true);
    // Past the chat pause window (60) but inside the workstation one (100):
    // a persistent session must NOT be touched by the chat branch.
    registry.get("sess_ws")!.last_active_at = agoIso(80);

    await runSweep(registry);

    expect(callbacks.onIdlePause).not.toHaveBeenCalled();
    expect(registry.get("sess_ws")!.status).toBe("active");
  });

  it("paused non-persistent chats neither consume nor fall victim to the workstation pause budget", async () => {
    const { registry } = makeRegistry({ maxPaused: 1 });

    // Oldest: a paused non-persistent chat.
    await registry.register("sess_chat", "ctr_chat", "user_1", "prof_1");
    registry.get("sess_chat")!.last_active_at = agoIso(90);
    await runSweep(registry);
    expect(registry.get("sess_chat")!.status).toBe("paused");

    // Two persistent workstations go idle past the workstation pause window.
    // With maxPaused=1, pausing the second must evict the FIRST WORKSTATION —
    // not the older paused chat.
    await registry.register("sess_ws1", "ctr_ws1", "user_1", "prof_1", true);
    registry.get("sess_ws1")!.last_active_at = agoIso(120);
    registry.get("sess_chat")!.last_active_at = agoIso(90); // keep chat inside its window
    await runSweep(registry);
    expect(registry.get("sess_ws1")!.status).toBe("paused");

    await registry.register("sess_ws2", "ctr_ws2", "user_1", "prof_1", true);
    registry.get("sess_ws2")!.last_active_at = agoIso(110);
    registry.get("sess_chat")!.last_active_at = agoIso(90);
    await runSweep(registry);

    expect(registry.get("sess_ws2")!.status).toBe("paused");
    expect(registry.get("sess_ws1")).toBeNull(); // evicted workstation
    expect(registry.get("sess_chat")).not.toBeNull(); // chat untouched
  });
});

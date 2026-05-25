import { describe, it, expect, vi } from "vitest";
import { createTracker } from "./tracker.js";
import type { EventRecord } from "./types.js";

describe("event-tracker core", () => {
  it("writes the record with defaults and created_at", async () => {
    const written: Array<EventRecord & { created_at: string }> = [];
    const tracker = createTracker({ write: async (e) => { written.push(e); } });

    const ok = await tracker.trackSync({ event: "user.signed_up", userId: "u_1" });

    expect(ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      event: "user.signed_up",
      source: "server",
      user_id: "u_1",
      session_id: null,
      properties: null,
      ip: null,
      user_agent: null,
    });
    expect(written[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts source=client and passes properties through", async () => {
    const written: Array<EventRecord & { created_at: string }> = [];
    const tracker = createTracker({ write: async (e) => { written.push(e); } });

    await tracker.trackSync({
      event: "ui.click",
      source: "client",
      userId: "u_2",
      properties: { path: "/agents", agentId: "prof_abc" },
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
    });

    expect(written[0]).toMatchObject({
      event: "ui.click",
      source: "client",
      user_id: "u_2",
      properties: { path: "/agents", agentId: "prof_abc" },
      ip: "1.2.3.4",
      user_agent: "Mozilla/5.0",
    });
  });

  it("fire-and-forget track never throws even when write fails", async () => {
    const err = vi.fn();
    const tracker = createTracker({
      write: async () => { throw new Error("db down"); },
      log: { error: err },
    });

    expect(() => tracker.track({ event: "x" })).not.toThrow();
    // Let the microtask queue drain so the async write() settles
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalled();
  });

  it("trackSync returns false on write failure", async () => {
    const tracker = createTracker({
      write: async () => { throw new Error("nope"); },
      log: { error: () => {} },
    });
    const ok = await tracker.trackSync({ event: "x" });
    expect(ok).toBe(false);
  });
});

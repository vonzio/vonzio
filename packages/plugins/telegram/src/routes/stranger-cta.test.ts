import { describe, it, expect } from "vitest";
import { createStrangerCtaGate } from "./stranger-cta.js";

const HOUR = 60 * 60 * 1000;

describe("createStrangerCtaGate", () => {
  it("allows the first CTA per chat and throttles repeats within the window", () => {
    const gate = createStrangerCtaGate({ perChatMs: 6 * HOUR, perMinuteMax: 20 });
    const t0 = 1_000_000;
    expect(gate.allow("chat1", t0)).toBe(true);
    expect(gate.allow("chat1", t0 + 1000)).toBe(false);
    expect(gate.allow("chat1", t0 + 6 * HOUR - 1)).toBe(false);
    expect(gate.allow("chat1", t0 + 6 * HOUR)).toBe(true);
  });

  it("throttles per chat independently", () => {
    const gate = createStrangerCtaGate();
    const t0 = 1_000_000;
    expect(gate.allow("a", t0)).toBe(true);
    expect(gate.allow("b", t0)).toBe(true);
    expect(gate.allow("a", t0 + 1)).toBe(false);
  });

  it("enforces the instance-wide per-minute cap across distinct chats (forged-id flood)", () => {
    const gate = createStrangerCtaGate({ perMinuteMax: 3 });
    const t0 = 1_000_000;
    expect(gate.allow("c1", t0)).toBe(true);
    expect(gate.allow("c2", t0 + 1)).toBe(true);
    expect(gate.allow("c3", t0 + 2)).toBe(true);
    // 4th distinct chat inside the same minute → blocked.
    expect(gate.allow("c4", t0 + 3)).toBe(false);
    // Window rolls over → allowed again.
    expect(gate.allow("c4", t0 + 60_000)).toBe(true);
  });

  it("a blocked attempt does not consume the chat's slot", () => {
    const gate = createStrangerCtaGate({ perMinuteMax: 1, perChatMs: HOUR });
    const t0 = 1_000_000;
    expect(gate.allow("x", t0)).toBe(true);
    // Blocked by the per-minute cap, NOT recorded as sent for chat y...
    expect(gate.allow("y", t0 + 1)).toBe(false);
    // ...so y is allowed as soon as the minute window rolls.
    expect(gate.allow("y", t0 + 60_000)).toBe(true);
  });
});

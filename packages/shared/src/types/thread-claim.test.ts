import { describe, it, expect } from "vitest";
import {
  TC_CLAIM_PREFIX,
  TC_DISMISS_PREFIX,
  THREAD_CLAIM_WINDOW_MS,
  encodeThreadClaim,
  encodeThreadDismiss,
  parseThreadCallback,
  switchedThreadDisclaimer,
} from "./thread-claim.js";

/**
 * Wire-format pins for the thread-claim feature. The Telegram producer
 * (NotificationService.sendViaTelegram) encodes; the consumer
 * (telegram-events callback dispatcher) parses. A drifting prefix would
 * silently break button-tap routing — these tests would catch it before
 * the prod symptom (taps with no effect).
 */
describe("thread-claim wire format", () => {
  it("encode → parse round-trip works for claim", () => {
    const data = encodeThreadClaim("pb-Xa0-zUc2");
    expect(data).toBe(`${TC_CLAIM_PREFIX}pb-Xa0-zUc2`);
    expect(parseThreadCallback(data)).toEqual({ action: "claim", sessionId: "pb-Xa0-zUc2" });
  });

  it("encode → parse round-trip works for dismiss", () => {
    const data = encodeThreadDismiss("pb-Xa0-zUc2");
    expect(data).toBe(`${TC_DISMISS_PREFIX}pb-Xa0-zUc2`);
    expect(parseThreadCallback(data)).toEqual({ action: "dismiss", sessionId: "pb-Xa0-zUc2" });
  });

  it("parseThreadCallback returns null for unrelated callback data", () => {
    expect(parseThreadCallback("model:42")).toBeNull();
    expect(parseThreadCallback("ask:sess:0")).toBeNull();
    expect(parseThreadCallback("")).toBeNull();
    expect(parseThreadCallback("tc-other:x")).toBeNull();
  });

  it("encoded form fits inside Telegram's 64-byte callback_data limit for typical session ids", () => {
    // Vonzio session ids: `pb-<nanoid21>` (~24 chars). Add the prefix, well under 64.
    const data = encodeThreadClaim("pb-1234567890abcdefghij");
    expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(64);
  });

  it("default-claim window is 24 hours", () => {
    expect(THREAD_CLAIM_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("switchedThreadDisclaimer formats label", () => {
    expect(switchedThreadDisclaimer("monthly-statement")).toBe("[Switched to monthly-statement thread]");
  });
});

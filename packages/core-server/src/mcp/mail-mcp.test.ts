import { describe, it, expect } from "vitest";
import { allowSend } from "./mail-mcp.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("mail_send throttle (allowSend)", () => {
  it("allows up to 5 sends per minute per integration, then blocks", () => {
    const id = "int_a";
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(allowSend(id, t0 + i)).toBe(true);
    expect(allowSend(id, t0 + 5)).toBe(false);
    // Minute rolls over → allowed again.
    expect(allowSend(id, t0 + 60_000)).toBe(true);
  });

  it("throttles each integration independently", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 5; i++) allowSend("int_b", t0 + i);
    expect(allowSend("int_b", t0 + 6)).toBe(false);
    // A different mailbox is unaffected.
    expect(allowSend("int_c", t0 + 6)).toBe(true);
  });

  it("enforces the 50/day cap across minutes", () => {
    const id = "int_d";
    let t = 3_000_000;
    let allowed = 0;
    // Spread sends one per minute so the per-minute cap never bites.
    for (let i = 0; i < 60; i++) {
      if (allowSend(id, t)) allowed++;
      t += 61_000;
    }
    expect(allowed).toBe(50);
    // Next day resets.
    expect(allowSend(id, t + DAY)).toBe(true);
  });
});

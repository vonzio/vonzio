import { describe, it, expect } from "vitest";
import { buildPresenceSection } from "./presence.js";

describe("buildPresenceSection", () => {
  it("background task (no surface) → tells agent NOT to call AskUserQuestion", () => {
    const out = buildPresenceSection({ dashboard: false, telegram: false, slack: false, any: false });
    expect(out).toMatch(/^## Reachability\n/);
    expect(out).toMatch(/No human is currently attached/);
    expect(out).toMatch(/Do NOT call `AskUserQuestion`/);
    // Includes the fallback strategy: assume, state, proceed
    expect(out).toMatch(/Make the most reasonable assumption/);
    expect(out).toMatch(/State the assumption explicitly/);
    expect(out).toMatch(/Proceed with the work/);
  });

  it("dashboard live → AskUserQuestion allowed, no phone-button steering", () => {
    const out = buildPresenceSection({ dashboard: true, telegram: false, slack: false, any: true });
    expect(out).toMatch(/^## Reachability\n/);
    expect(out).toMatch(/dashboard \(live tab open/);
    expect(out).toMatch(/`AskUserQuestion` is available/);
    expect(out).not.toMatch(/Do NOT call/);
    // Phone-only nudge should NOT appear when dashboard is live.
    expect(out).not.toMatch(/button options/);
  });

  it("telegram only (no dashboard) → adds phone-button steering", () => {
    const out = buildPresenceSection({ dashboard: false, telegram: true, slack: false, any: true });
    expect(out).toMatch(/Telegram \(chat bound/);
    expect(out).not.toMatch(/dashboard \(live/);
    expect(out).toMatch(/button options/);
    expect(out).toMatch(/typing back free-form text from a phone is slow/);
  });

  it("slack only (no dashboard) → same phone-button steering language", () => {
    const out = buildPresenceSection({ dashboard: false, telegram: false, slack: true, any: true });
    expect(out).toMatch(/Slack \(thread bound/);
    expect(out).toMatch(/button options/);
  });

  it("all surfaces live → lists all three, no phone-only nudge (dashboard is fast path)", () => {
    const out = buildPresenceSection({ dashboard: true, telegram: true, slack: true, any: true });
    expect(out).toMatch(/dashboard \(live tab open/);
    expect(out).toMatch(/Telegram \(chat bound/);
    expect(out).toMatch(/Slack \(thread bound/);
    expect(out).not.toMatch(/button options/);
  });

  it("the section always starts with the canonical heading so the template anchor matches", () => {
    const cases = [
      { dashboard: false, telegram: false, slack: false, any: false },
      { dashboard: true, telegram: false, slack: false, any: true },
      { dashboard: false, telegram: true, slack: true, any: true },
    ];
    for (const presence of cases) {
      expect(buildPresenceSection(presence).startsWith("## Reachability\n")).toBe(true);
    }
  });
});

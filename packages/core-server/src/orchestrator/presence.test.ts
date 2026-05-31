import { describe, it, expect } from "vitest";
import { buildPresenceSection, type Presence } from "./presence.js";

const TG: Presence["surfaces"][number] = {
  label: "Telegram (chat bound — may take minutes if the user isn't near their phone)",
  slow: true,
};
const SLACK: Presence["surfaces"][number] = {
  label: "Slack (thread bound — same latency caveat)",
  slow: true,
};

describe("buildPresenceSection", () => {
  it("background task (no surface) → tells agent NOT to call AskUserQuestion", () => {
    const out = buildPresenceSection({ dashboard: false, surfaces: [], any: false });
    expect(out).toMatch(/^## Reachability\n/);
    expect(out).toMatch(/No human is currently attached/);
    expect(out).toMatch(/Do NOT call `AskUserQuestion`/);
    // Includes the fallback strategy: assume, state, proceed
    expect(out).toMatch(/Make the most reasonable assumption/);
    expect(out).toMatch(/State the assumption explicitly/);
    expect(out).toMatch(/Proceed with the work/);
  });

  it("dashboard live → AskUserQuestion allowed, no phone-button steering", () => {
    const out = buildPresenceSection({ dashboard: true, surfaces: [], any: true });
    expect(out).toMatch(/^## Reachability\n/);
    expect(out).toMatch(/dashboard \(live tab open/);
    expect(out).toMatch(/`AskUserQuestion` is available/);
    expect(out).not.toMatch(/Do NOT call/);
    // Phone-only nudge should NOT appear when dashboard is live.
    expect(out).not.toMatch(/button options/);
  });

  it("telegram only (no dashboard) → adds phone-button steering", () => {
    const out = buildPresenceSection({ dashboard: false, surfaces: [TG], any: true });
    expect(out).toMatch(/Telegram \(chat bound/);
    expect(out).not.toMatch(/dashboard \(live/);
    expect(out).toMatch(/button options/);
    expect(out).toMatch(/typing back free-form text from a phone is slow/);
  });

  it("slack only (no dashboard) → same phone-button steering language", () => {
    const out = buildPresenceSection({ dashboard: false, surfaces: [SLACK], any: true });
    expect(out).toMatch(/Slack \(thread bound/);
    expect(out).toMatch(/button options/);
  });

  it("all surfaces live → lists all, no phone-only nudge (dashboard is fast path)", () => {
    const out = buildPresenceSection({ dashboard: true, surfaces: [TG, SLACK], any: true });
    expect(out).toMatch(/dashboard \(live tab open/);
    expect(out).toMatch(/Telegram \(chat bound/);
    expect(out).toMatch(/Slack \(thread bound/);
    expect(out).not.toMatch(/button options/);
  });

  it("chat surface without `slow` flag → no phone-button steering", () => {
    // A future surface (in-browser desktop notification etc.) may set
    // slow=false; in that case we shouldn't nudge toward buttons.
    const fast: Presence["surfaces"][number] = { label: "Custom (fast)", slow: false };
    const out = buildPresenceSection({ dashboard: false, surfaces: [fast], any: true });
    expect(out).toMatch(/Custom \(fast\)/);
    expect(out).not.toMatch(/button options/);
  });

  it("the section always starts with the canonical heading so the template anchor matches", () => {
    const cases: Presence[] = [
      { dashboard: false, surfaces: [], any: false },
      { dashboard: true, surfaces: [], any: true },
      { dashboard: false, surfaces: [TG, SLACK], any: true },
    ];
    for (const presence of cases) {
      expect(buildPresenceSection(presence).startsWith("## Reachability\n")).toBe(true);
    }
  });
});

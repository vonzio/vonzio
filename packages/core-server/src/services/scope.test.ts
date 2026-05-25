import { describe, it, expect } from "vitest";
import { normalizeScope, isGrantedToProfile } from "./scope.js";

describe("normalizeScope", () => {
  it("defaults to scope='all' with empty profile_ids", () => {
    expect(normalizeScope({})).toEqual({ scope: "all", profile_ids: [] });
  });

  it("clears profile_ids when scope='all' even if caller passed some", () => {
    expect(normalizeScope({ scope: "all", profile_ids: ["p1", "p2"] })).toEqual({
      scope: "all",
      profile_ids: [],
    });
  });

  it("rejects scope='agents' with empty profile_ids", () => {
    expect(() => normalizeScope({ scope: "agents" })).toThrow(/non-empty profile_ids/);
    expect(() => normalizeScope({ scope: "agents", profile_ids: [] })).toThrow(/non-empty profile_ids/);
  });

  it("dedupes profile_ids", () => {
    expect(normalizeScope({ scope: "agents", profile_ids: ["a", "b", "a"] })).toEqual({
      scope: "agents",
      profile_ids: ["a", "b"],
    });
  });

  it("rejects non-string profile_ids", () => {
    // @ts-expect-error — intentionally passing wrong type
    expect(() => normalizeScope({ scope: "agents", profile_ids: [123] })).toThrow();
    expect(() => normalizeScope({ scope: "agents", profile_ids: [""] })).toThrow();
  });

  it("rejects invalid scope values", () => {
    // @ts-expect-error — intentionally passing wrong type
    expect(() => normalizeScope({ scope: "everyone" })).toThrow(/scope must be/);
  });
});

describe("isGrantedToProfile", () => {
  it("scope='all' grants to every profile id", () => {
    expect(isGrantedToProfile({ scope: "all", profile_ids: [] }, "p1")).toBe(true);
    expect(isGrantedToProfile({ scope: "all", profile_ids: ["p2"] }, "p1")).toBe(true);
  });

  it("scope='agents' only grants when profile id is listed", () => {
    expect(isGrantedToProfile({ scope: "agents", profile_ids: ["p1", "p2"] }, "p1")).toBe(true);
    expect(isGrantedToProfile({ scope: "agents", profile_ids: ["p1", "p2"] }, "p3")).toBe(false);
    expect(isGrantedToProfile({ scope: "agents", profile_ids: [] }, "p1")).toBe(false);
  });
});

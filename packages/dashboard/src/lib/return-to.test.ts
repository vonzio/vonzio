import { describe, it, expect } from "vitest";
import { safeReturnTo } from "./return-to.js";

describe("safeReturnTo", () => {
  it("accepts plain internal paths (with query)", () => {
    expect(safeReturnTo("/device")).toBe("/device");
    expect(safeReturnTo("/device?user_code=AB-CD")).toBe("/device?user_code=AB-CD");
    expect(safeReturnTo("/settings/profile")).toBe("/settings/profile");
  });

  it("rejects empty / nullish", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo("")).toBeNull();
  });

  it("rejects absolute and protocol-relative URLs (open-redirect)", () => {
    expect(safeReturnTo("https://evil.com")).toBeNull();
    expect(safeReturnTo("//evil.com")).toBeNull();
    expect(safeReturnTo("http:/evil.com")).toBeNull();
    expect(safeReturnTo("/")).toBeNull(); // bare root → fall back to default
  });

  it("rejects backslash and control/whitespace bypasses", () => {
    expect(safeReturnTo("/\\evil.com")).toBeNull(); // browsers normalize \ → /
    expect(safeReturnTo("/\\/evil.com")).toBeNull();
    expect(safeReturnTo("/\t//evil.com")).toBeNull(); // tab stripped → //evil
    expect(safeReturnTo("/\n//evil.com")).toBeNull();
    expect(safeReturnTo(" /device")).toBeNull(); // leading space
  });
});

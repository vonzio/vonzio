import { describe, it, expect } from "vitest";
import { assertApiCompatible } from "./version.js";

describe("assertApiCompatible", () => {
  it("accepts same-major plugin (additive minor)", () => {
    expect(() => assertApiCompatible("0.1.0", "0.3.0")).not.toThrow();
    expect(() => assertApiCompatible("0.5.0", "0.1.0")).not.toThrow();
    expect(() => assertApiCompatible("1.2.0", "1.0.0")).not.toThrow();
  });

  it("rejects newer-major plugin", () => {
    expect(() => assertApiCompatible("1.0.0", "0.1.0")).toThrow(
      /Upgrade vonzio core to v1\.x/,
    );
    expect(() => assertApiCompatible("2.0.0", "1.5.0")).toThrow(
      /Upgrade vonzio core to v2\.x/,
    );
  });

  it("rejects older-major plugin", () => {
    expect(() => assertApiCompatible("0.1.0", "1.0.0")).toThrow(
      /incompatible with core's plugin-api 1\.0\.0/,
    );
  });

  it("rejects malformed plugin version", () => {
    expect(() => assertApiCompatible("not-a-version", "0.1.0")).toThrow(
      /Plugin declared invalid apiVersion/,
    );
    expect(() => assertApiCompatible("", "0.1.0")).toThrow(/invalid apiVersion/);
    expect(() => assertApiCompatible("abc", "0.1.0")).toThrow(/invalid apiVersion/);
  });

  it("defaults coreApiVersion to PLUGIN_API_VERSION", () => {
    // PLUGIN_API_VERSION is 0.1.0 at the time of writing this test.
    // A 0.x plugin should pass; a 1.x should fail.
    expect(() => assertApiCompatible("0.1.0")).not.toThrow();
    expect(() => assertApiCompatible("1.0.0")).toThrow();
  });
});

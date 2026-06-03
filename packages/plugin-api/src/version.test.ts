import { describe, it, expect } from "vitest";
import { assertApiCompatible } from "./version.js";

describe("assertApiCompatible", () => {
  it("accepts same major with plugin minor <= core minor", () => {
    expect(() => assertApiCompatible("1.0", "1.0.0")).not.toThrow();
    expect(() => assertApiCompatible("1.0.0", "1.3.0")).not.toThrow();
    expect(() => assertApiCompatible("1.2.0", "1.5.0")).not.toThrow();
    expect(() => assertApiCompatible("1.5", "1.5.9")).not.toThrow();
  });

  it("rejects plugin minor ahead of core minor (forward-incompatibility)", () => {
    expect(() => assertApiCompatible("1.3.0", "1.0.0")).toThrow(
      /plugin minor 3 > core minor 0/,
    );
    expect(() => assertApiCompatible("1.1", "1.0.0")).toThrow(/minor/);
  });

  it("rejects newer-major plugin", () => {
    expect(() => assertApiCompatible("2.0.0", "1.0.0")).toThrow(
      /Upgrade vonzio core to v2\.x/,
    );
  });

  it("rejects older-major plugin", () => {
    expect(() => assertApiCompatible("0.9.0", "1.0.0")).toThrow(
      /incompatible with core's plugin-api 1\.0\.0/,
    );
  });

  it("rejects malformed plugin version", () => {
    expect(() => assertApiCompatible("not-a-version", "1.0.0")).toThrow(
      /Plugin declared invalid apiVersion/,
    );
    expect(() => assertApiCompatible("", "1.0.0")).toThrow(/invalid apiVersion/);
    expect(() => assertApiCompatible("1", "1.0.0")).toThrow(/invalid apiVersion/);
  });

  it("defaults coreApiVersion to PLUGIN_API_VERSION (1.0.0)", () => {
    expect(() => assertApiCompatible("1.0")).not.toThrow();
    expect(() => assertApiCompatible("1.0.0")).not.toThrow();
    expect(() => assertApiCompatible("2.0.0")).toThrow();
    expect(() => assertApiCompatible("0.1.0")).toThrow();
  });
});

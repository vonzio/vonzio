import { describe, it, expect } from "vitest";
import { linkifyText } from "./ChatCore";

describe("linkifyText", () => {
  it("leaves a markdown link whose text is a URL untouched (the reported bug)", () => {
    const input = "[https://staging.fucec-togo.com/reseau](https://staging.fucec-togo.com/reseau) — stat card";
    // Must NOT become [[url](url)](url).
    expect(linkifyText(input)).toBe(input);
  });

  it("wraps a bare URL into a markdown link", () => {
    expect(linkifyText("Visit https://example.com now")).toBe(
      "Visit [https://example.com](https://example.com) now",
    );
  });

  it("leaves an existing [text](href) link alone", () => {
    const input = "See [the docs](https://example.com/docs) here";
    expect(linkifyText(input)).toBe(input);
  });

  it("does not linkify URLs inside inline or fenced code", () => {
    expect(linkifyText("code `https://nope.com` stays")).toBe("code `https://nope.com` stays");
    expect(linkifyText("```\nhttps://nope.com\n```")).toBe("```\nhttps://nope.com\n```");
  });

  it("leaves an autolink <url> alone", () => {
    expect(linkifyText("<https://auto.link>")).toBe("<https://auto.link>");
  });

  it("excludes a wrapping paren from the matched URL", () => {
    expect(linkifyText("(https://y.com)")).toBe("([https://y.com](https://y.com))");
  });
});

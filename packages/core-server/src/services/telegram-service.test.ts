import { describe, it, expect } from "vitest";
import { escapeMarkdownV2, markdownToTelegram, splitTelegramMessage } from "./telegram-service.js";

describe("escapeMarkdownV2", () => {
  it("escapes all reserved characters", () => {
    expect(escapeMarkdownV2("hello.world")).toBe("hello\\.world");
    expect(escapeMarkdownV2("a_b*c[d]")).toBe("a\\_b\\*c\\[d\\]");
    expect(escapeMarkdownV2("(x) {y} ~z~")).toBe("\\(x\\) \\{y\\} \\~z\\~");
    expect(escapeMarkdownV2("# h > q + - = | . !")).toBe("\\# h \\> q \\+ \\- \\= \\| \\. \\!");
  });

  it("escapes backslashes themselves", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });
});

describe("markdownToTelegram", () => {
  it("escapes plain text", () => {
    expect(markdownToTelegram("hello world.")).toBe("hello world\\.");
  });

  it("converts bold", () => {
    expect(markdownToTelegram("**bold text**")).toBe("*bold text*");
    expect(markdownToTelegram("a **bold** b")).toBe("a *bold* b");
  });

  it("converts headers to bold", () => {
    expect(markdownToTelegram("# Title")).toBe("*Title*");
    expect(markdownToTelegram("### Sub")).toBe("*Sub*");
  });

  it("preserves code blocks without escaping their content", () => {
    const result = markdownToTelegram("```\nfoo.bar()\n```");
    expect(result).toContain("foo.bar()");
    expect(result).not.toContain("\\.");
  });

  it("preserves inline code", () => {
    const result = markdownToTelegram("see `obj.foo` for details");
    expect(result).toContain("`obj.foo`");
    expect(result).toContain("details");
  });

  it("converts links with escaped labels", () => {
    const result = markdownToTelegram("see [my docs](https://example.com)");
    expect(result).toContain("[my docs](https://example.com)");
  });

  it("escapes special chars outside formatting", () => {
    const result = markdownToTelegram("price is $5.99 (was $7)");
    expect(result).toContain("\\.");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegram("~~old~~")).toBe("~old~");
  });

  it("handles mixed content end-to-end", () => {
    const md = "# Done\n\nFixed `bug.ts` and added **tests**. See [PR](https://example.com/pr/1).";
    const out = markdownToTelegram(md);
    expect(out).toContain("*Done*");
    expect(out).toContain("`bug.ts`");
    expect(out).toContain("*tests*");
    expect(out).toContain("[PR](https://example.com/pr/1)");
  });
});

describe("splitTelegramMessage", () => {
  it("returns a single chunk if under the limit", () => {
    expect(splitTelegramMessage("short text", 100)).toEqual(["short text"]);
  });

  it("splits at newline boundaries when possible", () => {
    const text = "line one\nline two\nline three";
    const chunks = splitTelegramMessage(text, 18);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(18));
  });

  it("falls back to hard split when no newline is near the limit", () => {
    const text = "a".repeat(100);
    const chunks = splitTelegramMessage(text, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

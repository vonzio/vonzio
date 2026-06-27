import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  markdownToTelegram,
  splitTelegramMessage,
  toTelegramHtml,
  chunkMarkdown,
  stripTelegramHtml,
} from "./telegram-service.js";

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

describe("toTelegramHtml", () => {
  it("renders bold and italic", () => {
    expect(toTelegramHtml("**bold** and _italic_")).toBe("<b>bold</b> and <i>italic</i>");
  });

  it("renders inline code without auto-linking dotted filenames", () => {
    // The bug: `dev-start.sh` / `CLAUDE.md` leaked as plain text and Telegram
    // auto-linked the .sh/.md TLD. Inside <code> it never linkifies.
    expect(toTelegramHtml("run `dev-start.sh`")).toBe("run <code>dev-start.sh</code>");
  });

  it("does not corrupt standalone numbers in prose (placeholder collision regression)", () => {
    const out = toTelegramHtml("you have 10 files on ports 3000 and 5432");
    expect(out).toBe("you have 10 files on ports 3000 and 5432");
  });

  it("escapes HTML special chars in text", () => {
    expect(toTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("renders fenced code with a language class", () => {
    expect(toTelegramHtml("```js\nfoo()\n```")).toBe('<pre><code class="language-js">foo()</code></pre>');
  });

  it("renders links", () => {
    expect(toTelegramHtml("[docs](https://example.com)")).toBe('<a href="https://example.com">docs</a>');
  });

  it("renders unordered lists with bullets", () => {
    expect(toTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  it("turns headers into bold", () => {
    expect(toTelegramHtml("# Title")).toBe("<b>Title</b>");
  });

  it("handles nested bold containing inline code", () => {
    expect(toTelegramHtml("**use `x` now**")).toBe("<b>use <code>x</code> now</b>");
  });
});

describe("stripTelegramHtml", () => {
  it("removes tags and unescapes entities", () => {
    expect(stripTelegramHtml("<b>a &lt; b</b> &amp; <code>c</code>")).toBe("a < b & c");
  });
});

describe("chunkMarkdown", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkMarkdown("short", 100)).toEqual(["short"]);
  });

  it("splits at block boundaries without cutting a code fence", () => {
    const md = "para one\n\n```js\nlong code block here\n```\n\npara two";
    const chunks = chunkMarkdown(md, 20);
    // The fenced block must stay intact within a single chunk.
    expect(chunks.some((c) => c.includes("```js\nlong code block here\n```"))).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { toHtml, toPlainText, toSlackMrkdwn } from "./format-message.js";

describe("format-message", () => {
  describe("toHtml", () => {
    it("renders headers, bold, lists, and links", () => {
      const md = "# Title\n\n**bold** and [link](https://x.dev)\n\n- one\n- two";
      const html = toHtml(md);
      expect(html).toContain("<h1>Title</h1>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain('<a href="https://x.dev">link</a>');
      expect(html).toContain("<li>one</li>");
    });

    it("strips raw HTML tags to prevent injection", () => {
      const md = "hello <script>alert(1)</script> world";
      const html = toHtml(md);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("</script>");
    });

    it("escapes HTML inside code blocks instead of rendering", () => {
      const md = "```\n<b>raw</b>\n```";
      const html = toHtml(md);
      expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
      expect(html).not.toContain("<b>raw</b>");
    });
  });

  describe("toPlainText", () => {
    it("strips headers, bold, italic markers", () => {
      expect(toPlainText("# Title")).toBe("Title");
      expect(toPlainText("**bold**")).toBe("bold");
      expect(toPlainText("_italic_")).toBe("italic");
      expect(toPlainText("~~strike~~")).toBe("strike");
    });

    it("converts links to text (url)", () => {
      expect(toPlainText("[docs](https://x.dev)")).toBe("docs (https://x.dev)");
    });

    it("converts bullets to • and preserves indentation", () => {
      const md = "- a\n- b\n  - c";
      expect(toPlainText(md)).toBe("• a\n• b\n  • c");
    });

    it("unwraps inline code and fenced code", () => {
      expect(toPlainText("use `npm test` here")).toBe("use npm test here");
      expect(toPlainText("```js\nconst x = 1;\n```")).toBe("const x = 1;");
    });

    it("collapses excess blank lines", () => {
      expect(toPlainText("a\n\n\n\nb")).toBe("a\n\nb");
    });
  });

  describe("toSlackMrkdwn", () => {
    it("converts ** bold to * bold", () => {
      expect(toSlackMrkdwn("**hello**")).toContain("*hello*");
    });

    it("converts headers to bold", () => {
      expect(toSlackMrkdwn("# Title")).toContain("*Title*");
    });

    it("converts links to <url|text>", () => {
      expect(toSlackMrkdwn("[docs](https://x.dev)")).toContain("<https://x.dev|docs>");
    });
  });
});

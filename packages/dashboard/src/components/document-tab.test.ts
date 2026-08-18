import { describe, it, expect } from "vitest";
import { documentKind, extractOfficeDocPath } from "./document-utils.js";

describe("documentKind", () => {
  it("routes each family to its carrier", () => {
    expect(documentKind("/workspace/Report.docx")).toBe("pdf-converted");
    expect(documentKind("/workspace/deck.PPTX")).toBe("pdf-converted");
    expect(documentKind("/workspace/old.doc")).toBe("pdf-converted");
    expect(documentKind("/workspace/data.xlsx")).toBe("html-converted");
    expect(documentKind("/workspace/manual.pdf")).toBe("pdf-raw");
    expect(documentKind("/workspace/script.py")).toBeNull();
    expect(documentKind("/workspace/archive.zip")).toBeNull();
  });
});

describe("extractOfficeDocPath", () => {
  it("finds a /workspace office path in assistant prose", () => {
    expect(extractOfficeDocPath("Your letter is ready: /workspace/Account_Closure_Letter.docx — fill in the blanks."))
      .toBe("/workspace/Account_Closure_Letter.docx");
  });

  it("normalizes a rewritten /preview/<id>/files link back to its workspace path", () => {
    expect(extractOfficeDocPath("[letter](/preview/abc123def456/files/workspace/out/Letter.docx)"))
      .toBe("/workspace/out/Letter.docx");
  });

  it("decodes percent-encoded hrefs", () => {
    expect(extractOfficeDocPath("/preview/abc123def456/files/workspace/Account%20Closure.docx"))
      .toBe("/workspace/Account Closure.docx");
  });

  it("ignores bare pdfs and non-office files (agents READ pdfs constantly)", () => {
    expect(extractOfficeDocPath("Reading /workspace/manual.pdf for context")).toBeNull();
    expect(extractOfficeDocPath("Created /workspace/main.py")).toBeNull();
    expect(extractOfficeDocPath("no paths at all")).toBeNull();
  });

  it("stops at markdown/link delimiters", () => {
    expect(extractOfficeDocPath("(/workspace/a.xlsx), then more"))
      .toBe("/workspace/a.xlsx");
  });
});

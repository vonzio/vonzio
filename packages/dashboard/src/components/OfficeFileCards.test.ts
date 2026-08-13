import { describe, it, expect } from "vitest";
import { extractOfficeFiles } from "./OfficeFileCards.js";

describe("extractOfficeFiles", () => {
  it("finds office documents stated in prose, deduped, in order", () => {
    const text =
      "I created `/workspace/q3-report.docx` and the data behind it at " +
      "/workspace/data/q3 figures.xlsx is not a path (space), but " +
      "/workspace/data/q3-figures.xlsx is. Also /workspace/deck.pptx and " +
      "again /workspace/q3-report.docx.";
    expect(extractOfficeFiles(text)).toEqual([
      "/workspace/q3-report.docx",
      "/workspace/data/q3-figures.xlsx",
      "/workspace/deck.pptx",
    ]);
  });

  it("strips trailing sentence punctuation but keeps dots inside names", () => {
    expect(extractOfficeFiles("Saved to /workspace/v1.2/final.report.pdf.")).toEqual([
      "/workspace/v1.2/final.report.pdf",
    ]);
  });

  it("ignores non-office extensions, other roots, and dot-segments", () => {
    expect(extractOfficeFiles("see /workspace/app.tsx and /knowledge/spec.docx")).toEqual([]);
    // The fileserver refuses dot-prefixed segments — no card that would 404.
    expect(extractOfficeFiles("cache at /workspace/.cache/tmp.docx")).toEqual([]);
  });

  it("handles markdown/code punctuation around paths", () => {
    expect(extractOfficeFiles("[deck](/workspace/deck.pptx) and (`/workspace/sheet.xlsx`)")).toEqual([
      "/workspace/deck.pptx",
      "/workspace/sheet.xlsx",
    ]);
  });

  it("returns empty on empty or workspace-free text", () => {
    expect(extractOfficeFiles("")).toEqual([]);
    expect(extractOfficeFiles("plain answer, no files")).toEqual([]);
  });
});

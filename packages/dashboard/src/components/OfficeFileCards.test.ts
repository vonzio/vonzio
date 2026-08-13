import { describe, it, expect } from "vitest";
import { extractOfficeFiles } from "./OfficeFileCards.js";

describe("extractOfficeFiles", () => {
  it("finds workspace document paths in prose, deduped, in order", () => {
    const text =
      "I created `/workspace/q3-report.docx` and " +
      "/workspace/data/q3-figures.xlsx. Also /workspace/deck.pptx and " +
      "again /workspace/q3-report.docx.";
    expect(extractOfficeFiles(text)).toEqual([
      { name: "q3-report.docx", target: "/workspace/q3-report.docx", kind: "path" },
      { name: "q3-figures.xlsx", target: "/workspace/data/q3-figures.xlsx", kind: "path" },
      { name: "deck.pptx", target: "/workspace/deck.pptx", kind: "path" },
    ]);
  });

  it("finds office files linked by URL (markdown link targets), query preserved", () => {
    const text = "Deck's ready: [vonzio_deck.pptx](http://localhost:3000/preview/cleverwilliams/8765/vonzio_deck.pptx?_pvt=196fa6)";
    expect(extractOfficeFiles(text)).toEqual([
      {
        name: "vonzio_deck.pptx",
        target: "http://localhost:3000/preview/cleverwilliams/8765/vonzio_deck.pptx?_pvt=196fa6",
        kind: "url",
      },
    ]);
  });

  it("collapses a path and a URL for the same file into one card (path wins)", () => {
    const text = "Saved /workspace/deck.pptx — download: https://x.test/files/deck.pptx";
    expect(extractOfficeFiles(text)).toEqual([
      { name: "deck.pptx", target: "/workspace/deck.pptx", kind: "path" },
    ]);
  });

  it("strips trailing sentence punctuation but keeps dots inside names", () => {
    expect(extractOfficeFiles("Saved to /workspace/v1.2/final.report.pdf.")).toEqual([
      { name: "final.report.pdf", target: "/workspace/v1.2/final.report.pdf", kind: "path" },
    ]);
  });

  it("ignores non-office extensions, other roots, and dot-segments", () => {
    expect(extractOfficeFiles("see /workspace/app.tsx and /knowledge/spec.docx")).toEqual([]);
    // The fileserver refuses dot-prefixed segments — no card that would 404.
    expect(extractOfficeFiles("cache at /workspace/.cache/tmp.docx")).toEqual([]);
  });

  it("returns empty on empty or document-free text", () => {
    expect(extractOfficeFiles("")).toEqual([]);
    expect(extractOfficeFiles("plain answer, no files")).toEqual([]);
  });
});

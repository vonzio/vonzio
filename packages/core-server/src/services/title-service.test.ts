import { describe, it, expect } from "vitest";
import { clean, heuristicTitle } from "./title-service.js";

describe("title-service clean()", () => {
  it("returns null for empty/whitespace", () => {
    expect(clean("")).toBeNull();
    expect(clean(null)).toBeNull();
    expect(clean(undefined)).toBeNull();
    expect(clean("   \n  ")).toBeNull();
  });

  it("strips surrounding quotes and trailing punctuation", () => {
    expect(clean('"Why the sky is blue"')).toBe("Why the sky is blue");
    expect(clean("Sky colors.")).toBe("Sky colors");
    expect(clean("Sudoku game?")).toBe("Sudoku game");
  });

  it("drops a leading Title: label", () => {
    expect(clean("Title: Build a Sudoku game")).toBe("Build a Sudoku game");
    expect(clean("title - Togo head of state")).toBe("Togo head of state");
  });

  it("takes the last non-empty line (reasoning models emit the answer last)", () => {
    expect(clean("Let me think about this...\n\nTogo's President")).toBe("Togo's President");
  });

  it("rejects an over-long reply (likely a paragraph, not a title)", () => {
    const long = "x".repeat(120);
    expect(clean(long)).toBeNull();
  });

  it("keeps a normal short title unchanged", () => {
    expect(clean("Why Sky Is Blue And Rainbows")).toBe("Why Sky Is Blue And Rainbows");
  });
});

describe("title-service heuristicTitle()", () => {
  it("strips a leading filler phrase and capitalizes", () => {
    expect(heuristicTitle("can you build a sudoku game")).toBe("Build a sudoku game");
    expect(heuristicTitle("please summarize this")).toBe("Summarize this");
  });

  it("truncates long prompts at a word boundary", () => {
    const t = heuristicTitle("Explain in great detail the entire history of the Roman empire please");
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t).not.toMatch(/\s$/);
  });

  it("falls back to Untitled for empty input", () => {
    expect(heuristicTitle("")).toBe("Untitled");
  });
});

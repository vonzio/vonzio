import { describe, it, expect } from "vitest";
import { confineToWorkspace, parseDocpreviewOutput } from "./preview.js";

describe("confineToWorkspace", () => {
  it("accepts an absolute path already under /workspace (the file viewer / tool paths)", () => {
    expect(confineToWorkspace("/workspace/build_resume.py")).toBe("/workspace/build_resume.py");
    expect(confineToWorkspace("/workspace/sub/cover.png")).toBe("/workspace/sub/cover.png");
  });

  it("roots a relative path at /workspace", () => {
    expect(confineToWorkspace("build_resume.py")).toBe("/workspace/build_resume.py");
    expect(confineToWorkspace("sub/cover.png")).toBe("/workspace/sub/cover.png");
  });

  it("rejects traversal and foreign absolute paths", () => {
    expect(confineToWorkspace("/etc/passwd")).toBeNull();
    expect(confineToWorkspace("/workspace/../etc/passwd")).toBeNull();
    expect(confineToWorkspace("../etc")).toBeNull();
    expect(confineToWorkspace("../../root/.ssh/id_rsa")).toBeNull();
  });
});

describe("parseDocpreviewOutput", () => {
  it("finds the converted path among interleaved soffice chatter", () => {
    const output = [
      "convert /workspace/Report.docx -> /tmp/docpreview/ab12cd34ef56ab12/Report.pdf using filter : writer_pdf_Export",
      "/tmp/docpreview/ab12cd34ef56ab12/Report.pdf",
      "",
    ].join("\n");
    expect(parseDocpreviewOutput(output)).toBe("/tmp/docpreview/ab12cd34ef56ab12/Report.pdf");
  });

  it("accepts html artifacts (xlsx renders)", () => {
    expect(parseDocpreviewOutput("/tmp/docpreview/0011223344556677/Sheet.html\n"))
      .toBe("/tmp/docpreview/0011223344556677/Sheet.html");
  });

  it("does NOT match paths mentioned mid-sentence, other roots, or other extensions", () => {
    expect(parseDocpreviewOutput("wrote /tmp/docpreview/aa/x.pdf ok")).toBeNull();
    expect(parseDocpreviewOutput("/workspace/x.pdf")).toBeNull();
    expect(parseDocpreviewOutput("/tmp/docpreview/aa/x.exe")).toBeNull();
    expect(parseDocpreviewOutput("docpreview: unsupported extension: zip")).toBeNull();
    expect(parseDocpreviewOutput("")).toBeNull();
  });
});

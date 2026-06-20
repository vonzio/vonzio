import { describe, it, expect } from "vitest";
import { confineToWorkspace } from "./preview.js";

describe("confineToWorkspace", () => {
  it("accepts an absolute path already under /workspace (the file viewer / tool paths)", () => {
    expect(confineToWorkspace("/workspace/build_resume.py")).toBe("/workspace/build_resume.py");
    expect(confineToWorkspace("/workspace/output/cover.png")).toBe("/workspace/output/cover.png");
  });

  it("roots a relative path at /workspace", () => {
    expect(confineToWorkspace("build_resume.py")).toBe("/workspace/build_resume.py");
    expect(confineToWorkspace("output/cover.png")).toBe("/workspace/output/cover.png");
  });

  it("rejects traversal and foreign absolute paths", () => {
    expect(confineToWorkspace("/etc/passwd")).toBeNull();
    expect(confineToWorkspace("/workspace/../etc/passwd")).toBeNull();
    expect(confineToWorkspace("../etc")).toBeNull();
    expect(confineToWorkspace("../../root/.ssh/id_rsa")).toBeNull();
  });
});

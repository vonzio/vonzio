import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { repackBundle, parseFrontmatter, BundleError } from "./skill-service.js";

const SKILL_MD = `---
name: drama-cover-kit
description: Make a cinematic cover for a short drama.
---

# Drama Cover Kit
Body here.
`;

describe("parseFrontmatter", () => {
  it("extracts name and description", () => {
    expect(parseFrontmatter(SKILL_MD)).toEqual({
      name: "drama-cover-kit",
      description: "Make a cinematic cover for a short drama.",
    });
  });

  it("returns empty when there's no frontmatter", () => {
    expect(parseFrontmatter("# no frontmatter")).toEqual({});
  });
});

describe("repackBundle", () => {
  it("re-roots a nested export so SKILL.md sits at the top, drops junk", () => {
    const zip = new AdmZip();
    zip.addFile("output/skills/drama-cover-kit/SKILL.md", Buffer.from(SKILL_MD));
    zip.addFile("output/skills/drama-cover-kit/scripts/make_cover.py", Buffer.from("print('hi')"));
    zip.addFile("output/skills/drama-cover-kit/assets/font.ttf", Buffer.from("FONTBYTES"));
    zip.addFile("__MACOSX/._SKILL.md", Buffer.from("junk"));
    zip.addFile("output/skills/drama-cover-kit/.DS_Store", Buffer.from("junk"));

    const r = repackBundle(zip.toBuffer());

    expect(parseFrontmatter(r.content).name).toBe("drama-cover-kit");
    expect(r.manifest).toEqual(["SKILL.md", "assets/font.ttf", "scripts/make_cover.py"]);
    expect(r.totalBytes).toBe(SKILL_MD.length + "print('hi')".length + "FONTBYTES".length);

    const re = new AdmZip(r.archive);
    const names = re.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(["SKILL.md", "assets/font.ttf", "scripts/make_cover.py"]);
  });

  it("handles a flat zip (SKILL.md already at root)", () => {
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(SKILL_MD));
    zip.addFile("scripts/run.sh", Buffer.from("echo hi"));
    const r = repackBundle(zip.toBuffer());
    expect(r.manifest).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("throws when there's no SKILL.md", () => {
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("nope"));
    expect(() => repackBundle(zip.toBuffer())).toThrow(BundleError);
  });

  it("throws on a non-zip buffer", () => {
    expect(() => repackBundle(Buffer.from("not a zip"))).toThrow(BundleError);
  });

  it("rejects a zip-slip path-traversal entry", () => {
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(SKILL_MD));
    zip.addFile("placeholder.sh", Buffer.from("pwned"));
    // adm-zip sanitizes `..` on addFile, so force a traversal name onto the
    // entry to simulate a hand-crafted malicious archive.
    const evil = zip.getEntries().find((e) => e.entryName.endsWith("placeholder.sh"))!;
    evil.entryName = "../evil.sh";
    expect(() => repackBundle(zip.toBuffer())).toThrow(BundleError);
  });
});

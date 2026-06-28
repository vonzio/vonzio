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

// ─── readBundleFile / readBundleFileRaw (DB + storage stubbed) ─────────────

import { SkillService } from "./skill-service.js";

function makeBundle(): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(SKILL_MD));
  zip.addFile("scripts/make_cover.py", Buffer.from("print('hi')"));
  zip.addFile("assets/font.ttf", Buffer.from([0x00, 0x01, 0x02, 0x00, 0x46])); // NUL → binary
  return zip.toBuffer();
}

/** SkillService backed by a single canned row + an in-memory archive. */
function serviceFor(row: Record<string, unknown> & { id: string }, archive: Buffer | null): SkillService {
  const full = {
    user_id: "user_1", name: "drama-cover-kit", description: "d",
    content: SKILL_MD, source: "uploaded", archive_key: archive ? "k.zip" : null,
    size_bytes: 0, manifest: ["SKILL.md", "assets/font.ttf", "scripts/make_cover.py"],
    created_at: "", updated_at: "", ...row,
  };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([full]) }) }),
  } as never;
  const storage = {
    get: async () => { if (!archive) throw new Error("missing"); return archive; },
    put: async () => {}, delete: async () => {},
  } as never;
  return new SkillService(db, "/nonexistent", storage);
}

describe("readBundleFile", () => {
  it("reads a text file inline", async () => {
    const svc = serviceFor({ id: "skill_1" }, makeBundle());
    const f = await svc.readBundleFile("skill_1", "scripts/make_cover.py", "user_1");
    expect(f).toMatchObject({ path: "scripts/make_cover.py", content: "print('hi')", binary: false, truncated: false });
  });

  it("flags a binary file (no inline content)", async () => {
    const svc = serviceFor({ id: "skill_1" }, makeBundle());
    const f = await svc.readBundleFile("skill_1", "assets/font.ttf", "user_1");
    expect(f).toMatchObject({ binary: true, content: null });
  });

  it("rejects a path not in the manifest (zip-slip guard)", async () => {
    const svc = serviceFor({ id: "skill_1" }, makeBundle());
    expect(await svc.readBundleFile("skill_1", "../../etc/passwd", "user_1")).toBeNull();
  });

  it("rejects a non-owner", async () => {
    const svc = serviceFor({ id: "skill_1", user_id: "owner" }, makeBundle());
    expect(await svc.readBundleFile("skill_1", "SKILL.md", "someone_else")).toBeNull();
  });

  it("allows a shared skill (user_id null) for any user", async () => {
    const svc = serviceFor({ id: "skill_1", user_id: null as never }, makeBundle());
    const f = await svc.readBundleFile("skill_1", "scripts/make_cover.py", "anyone");
    expect(f?.content).toBe("print('hi')");
  });

  it("returns null for a non-bundle skill", async () => {
    const svc = serviceFor({ id: "skill_1", archive_key: null }, null);
    expect(await svc.readBundleFile("skill_1", "SKILL.md", "user_1")).toBeNull();
  });

  it("returns null for a filesystem skill id", async () => {
    const svc = serviceFor({ id: "fs_foo" }, makeBundle());
    expect(await svc.readBundleFile("fs_foo", "SKILL.md", "user_1")).toBeNull();
  });

  it("truncates an oversized text file", async () => {
    const big = "x".repeat(600 * 1024);
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(SKILL_MD));
    zip.addFile("big.txt", Buffer.from(big));
    const svc = serviceFor({ id: "skill_1", manifest: ["SKILL.md", "big.txt"] }, zip.toBuffer());
    const f = await svc.readBundleFile("skill_1", "big.txt", "user_1");
    expect(f?.truncated).toBe(true);
    expect(f!.content!.length).toBe(512 * 1024);
    expect(f?.size).toBe(big.length);
  });
});

describe("readBundleFileRaw", () => {
  it("returns exact bytes for a binary file", async () => {
    const svc = serviceFor({ id: "skill_1" }, makeBundle());
    const buf = await svc.readBundleFileRaw("skill_1", "assets/font.ttf", "user_1");
    expect(Array.from(buf!)).toEqual([0x00, 0x01, 0x02, 0x00, 0x46]);
  });

  it("rejects a path outside the manifest", async () => {
    const svc = serviceFor({ id: "skill_1" }, makeBundle());
    expect(await svc.readBundleFileRaw("skill_1", "secret", "user_1")).toBeNull();
  });
});

describe("downloadSkill", () => {
  it("returns the stored archive for a bundle skill", async () => {
    const archive = makeBundle();
    const svc = serviceFor({ id: "skill_1" }, archive);
    const out = await svc.downloadSkill("skill_1", "user_1");
    expect(out?.filename).toBe("drama-cover-kit.zip");
    expect(Array.from(new AdmZip(out!.bytes).getEntries().map((e) => e.entryName)).sort())
      .toEqual(["SKILL.md", "assets/font.ttf", "scripts/make_cover.py"]);
  });

  it("zips SKILL.md for a single-file skill", async () => {
    const svc = serviceFor({ id: "skill_1", archive_key: null }, null);
    const out = await svc.downloadSkill("skill_1", "user_1");
    const entries = new AdmZip(out!.bytes).getEntries();
    expect(entries.map((e) => e.entryName)).toEqual(["SKILL.md"]);
    expect(entries[0].getData().toString("utf-8")).toBe(SKILL_MD);
  });

  it("rejects a non-owner", async () => {
    const svc = serviceFor({ id: "skill_1", user_id: "owner" }, makeBundle());
    expect(await svc.downloadSkill("skill_1", "someone_else")).toBeNull();
  });

  it("refuses a path-traversal filesystem id (containment guard)", async () => {
    const svc = serviceFor({ id: "fs_x" }, null);
    // `/nonexistent` is the skillsDir; a `..`-laden id must not escape it.
    expect(await svc.downloadSkill("fs_../../../../etc", "user_1")).toBeNull();
  });
});

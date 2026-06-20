import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Blob storage for uploaded skill bundles (zip archives). Kept behind a tiny
 * interface so the filesystem implementation (a mounted volume in prod) can be
 * swapped for an object store (S3-compatible) later without touching callers.
 */
export interface SkillStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Filesystem-backed store rooted at a single directory (SKILLS_DATA_DIR). */
export class FsSkillStorage implements SkillStorage {
  constructor(private rootDir: string) {}

  private resolve(key: string): string {
    // Keys are server-generated (`<skill_id>.zip`); reject anything with a path
    // separator so a malformed key can't escape the root.
    if (key.includes("/") || key.includes("\\") || key.includes("..")) {
      throw new Error(`invalid skill storage key: ${key}`);
    }
    return path.join(this.rootDir, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.resolve(key), data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

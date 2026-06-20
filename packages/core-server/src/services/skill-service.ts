import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import AdmZip from "adm-zip";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { SkillStorage } from "./skill-storage.js";

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: "filesystem" | "uploaded";
  /** Set for bundle skills (SKILL.md + scripts/assets); null for single-file. */
  archive_key: string | null;
  size_bytes: number | null;
  manifest: string[] | null;
  created_at: string;
  updated_at: string;
}

/** A resolved skill ready to mount: bundle (zip bytes) or single SKILL.md. */
export interface ResolvedSkill {
  name: string;
  description: string;
  content: string;
  /** Zip archive (re-rooted so SKILL.md sits at the top) for bundle skills. */
  archive: Buffer | null;
}

export interface UploadSkillInput {
  name: string;
  description: string;
  content: string;
}

/** Hard ceiling on a bundle's total uncompressed size. */
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export class SkillService {
  constructor(
    private db: DrizzleDB,
    private skillsDir: string,
    private storage: SkillStorage,
  ) {}

  async list(userId?: string): Promise<Skill[]> {
    const query = this.db.select().from(schema.skills);
    const dbSkills = userId
      ? await query.where(or(eq(schema.skills.user_id, userId), isNull(schema.skills.user_id)))
      : await query;
    const fsSkills = this.scanFilesystem();

    const byName = new Map<string, Skill>();
    for (const s of fsSkills) byName.set(s.name, s);
    for (const row of dbSkills) byName.set(row.name, this.mapRow(row));

    return Array.from(byName.values());
  }

  async get(id: string): Promise<Skill | null> {
    const rows = await this.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, id));
    if (rows.length > 0) return this.mapRow(rows[0]);

    if (id.startsWith("fs_")) {
      const fsSkills = this.scanFilesystem();
      return fsSkills.find((s) => s.id === id) ?? null;
    }

    return null;
  }

  /** Create a single-file (SKILL.md only) skill from typed fields. */
  async upload(input: UploadSkillInput, userId?: string): Promise<Skill> {
    const id = `skill_${nanoid()}`;
    const now = new Date().toISOString();

    const row = {
      id,
      user_id: userId ?? null,
      name: input.name,
      description: input.description,
      content: input.content,
      source: "uploaded" as const,
      archive_key: null,
      size_bytes: null,
      manifest: null,
      created_at: now,
      updated_at: now,
    };

    await this.db.insert(schema.skills).values(row);
    return this.mapRow(row);
  }

  /**
   * Create a bundle skill from an uploaded zip. Finds the SKILL.md, re-roots the
   * archive so SKILL.md is at the top (handles nested `output/skills/<name>/…`
   * exports), parses frontmatter for name/description, then persists the
   * re-rooted zip via SkillStorage.
   */
  async uploadBundle(zipBuffer: Buffer, userId?: string): Promise<Skill> {
    const { archive, content, manifest, totalBytes } = repackBundle(zipBuffer);
    const parsed = parseFrontmatter(content);
    const name = sanitizeName(parsed.name ?? "skill");

    const id = `skill_${nanoid()}`;
    const archiveKey = `${id}.zip`;
    await this.storage.put(archiveKey, archive);

    const now = new Date().toISOString();
    const row = {
      id,
      user_id: userId ?? null,
      name,
      description: parsed.description ?? `Skill: ${name}`,
      content,
      source: "uploaded" as const,
      archive_key: archiveKey,
      size_bytes: totalBytes,
      manifest,
      created_at: now,
      updated_at: now,
    };

    await this.db.insert(schema.skills).values(row);
    return this.mapRow(row);
  }

  /**
   * Update an owned skill's name/description/body. For bundle skills, a changed
   * body rewrites the SKILL.md inside the stored archive so the mounted skill
   * reflects it. Returns null if not found / not owned / read-only (filesystem).
   */
  async update(
    id: string,
    patch: { name?: string; description?: string; content?: string },
    userId?: string,
  ): Promise<Skill | null> {
    if (id.startsWith("fs_")) return null;
    const rows = await this.db.select().from(schema.skills).where(eq(schema.skills.id, id));
    if (rows.length === 0) return null;
    const existing = rows[0];
    if (userId && existing.user_id && existing.user_id !== userId) return null;

    const updates: Partial<typeof schema.skills.$inferInsert> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.content !== undefined) updates.content = patch.content;

    // Bundle skill: rewrite SKILL.md inside the archive and refresh size.
    if (patch.content !== undefined && existing.archive_key) {
      try {
        const buf = await this.storage.get(existing.archive_key);
        const zip = new AdmZip(buf);
        zip.deleteFile("SKILL.md");
        zip.addFile("SKILL.md", Buffer.from(patch.content, "utf-8"));
        await this.storage.put(existing.archive_key, zip.toBuffer());
        updates.size_bytes = zip.getEntries().reduce((n, e) => n + (e.isDirectory ? 0 : e.header.size), 0);
      } catch { /* archive missing — DB content still updates */ }
    }

    await this.db.update(schema.skills).set(updates).where(eq(schema.skills.id, id));
    return this.mapRow({ ...existing, ...updates });
  }

  async delete(id: string): Promise<boolean> {
    if (id.startsWith("fs_")) return false;
    const existing = await this.get(id);
    const result = await this.db.delete(schema.skills).where(eq(schema.skills.id, id)).returning();
    if (existing?.archive_key) {
      await this.storage.delete(existing.archive_key).catch(() => { /* best effort */ });
    }
    return result.length > 0;
  }

  /**
   * Resolve skills by ID list for mounting into a container. Loads bundle zip
   * bytes from storage so the orchestrator can unpack them.
   */
  async resolveSkills(skillIds: string[]): Promise<ResolvedSkill[]> {
    const allSkills = await this.list();
    const picked = skillIds
      .map((id) => allSkills.find((s) => s.id === id))
      .filter((s): s is Skill => !!s);

    const resolved: ResolvedSkill[] = [];
    for (const s of picked) {
      let archive: Buffer | null = null;
      if (s.archive_key) {
        try {
          archive = await this.storage.get(s.archive_key);
        } catch {
          // Archive missing — fall back to the SKILL.md body so the skill still
          // partially works rather than vanishing.
          archive = null;
        }
      }
      resolved.push({ name: s.name, description: s.description, content: s.content, archive });
    }
    return resolved;
  }

  scanFilesystem(): Skill[] {
    const skills: Skill[] = [];
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.skillsDir);
    } catch {
      return skills;
    }

    for (const dir of dirs) {
      const skillDir = path.join(this.skillsDir, dir);
      const skillFile = path.join(skillDir, "SKILL.md");

      try {
        const stat = fs.statSync(skillDir);
        if (!stat.isDirectory()) continue;
        if (!fs.existsSync(skillFile)) continue;

        const content = fs.readFileSync(skillFile, "utf-8");
        const parsed = parseFrontmatter(content);

        skills.push({
          id: `fs_${dir}`,
          name: dir,
          description: parsed.description ?? `Skill: ${dir}`,
          content,
          source: "filesystem",
          archive_key: null,
          size_bytes: null,
          manifest: null,
          created_at: stat.birthtime.toISOString(),
          updated_at: stat.mtime.toISOString(),
        });
      } catch {
        continue;
      }
    }

    return skills;
  }

  private mapRow(row: typeof schema.skills.$inferSelect): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      source: row.source as "filesystem" | "uploaded",
      archive_key: row.archive_key ?? null,
      size_bytes: row.size_bytes ?? null,
      manifest: row.manifest ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

// ─── Bundle helpers (exported for tests) ──────────────────────────────────

/** Parse YAML frontmatter `name` and `description` from a SKILL.md body. */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const block = fm[1];
  const grab = (key: string) => {
    const m = block.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  return { name: grab("name"), description: grab("description") };
}

function sanitizeName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "skill";
}

/** Junk entries macOS/editors add that should never ship in a skill. */
function isJunk(entryName: string): boolean {
  return entryName.startsWith("__MACOSX/")
    || entryName.split("/").some((seg) => seg === ".DS_Store" || seg === "Thumbs.db");
}

/**
 * Validate + re-root an uploaded zip. Finds the shallowest SKILL.md, strips its
 * parent prefix from every entry, drops junk, enforces the size cap, and returns
 * a fresh zip with SKILL.md at the top plus the SKILL.md body and file manifest.
 */
export function repackBundle(zipBuffer: Buffer): {
  archive: Buffer;
  content: string;
  manifest: string[];
  totalBytes: number;
} {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new BundleError("Not a valid zip file.");
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory && !isJunk(e.entryName));

  // Locate the shallowest SKILL.md (handles `output/skills/<name>/SKILL.md`).
  const skillMd = entries
    .filter((e) => e.entryName === "SKILL.md" || e.entryName.endsWith("/SKILL.md"))
    .sort((a, b) => a.entryName.split("/").length - b.entryName.split("/").length)[0];
  if (!skillMd) {
    throw new BundleError("No SKILL.md found in the archive.");
  }

  const prefix = skillMd.entryName.slice(0, skillMd.entryName.length - "SKILL.md".length);
  const rooted = entries.filter((e) => e.entryName.startsWith(prefix));

  const out = new AdmZip();
  const manifest: string[] = [];
  let totalBytes = 0;
  for (const e of rooted) {
    const rel = e.entryName.slice(prefix.length);
    if (!rel) continue;
    const data = e.getData();
    totalBytes += data.length;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new BundleError(`Skill bundle exceeds the ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)}MB limit.`);
    }
    out.addFile(rel, data);
    manifest.push(rel);
  }

  const content = skillMd.getData().toString("utf-8");
  manifest.sort();
  return { archive: out.toBuffer(), content, manifest, totalBytes };
}

export class BundleError extends Error {}

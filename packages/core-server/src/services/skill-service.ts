import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: "filesystem" | "uploaded";
  created_at: string;
  updated_at: string;
}

export interface UploadSkillInput {
  name: string;
  description: string;
  content: string;
}

export class SkillService {
  constructor(
    private db: DrizzleDB,
    private skillsDir: string,
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
      created_at: now,
      updated_at: now,
    };

    await this.db.insert(schema.skills).values(row);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<boolean> {
    if (id.startsWith("fs_")) return false;
    const result = await this.db.delete(schema.skills).where(eq(schema.skills.id, id)).returning();
    return result.length > 0;
  }

  /** Resolve skills by ID list. Returns name + content pairs for writing into containers. */
  async resolveSkills(skillIds: string[]): Promise<{ name: string; description: string; content: string }[]> {
    const allSkills = await this.list();
    return skillIds
      .map((id) => allSkills.find((s) => s.id === id))
      .filter((s): s is Skill => !!s)
      .map((s) => ({ name: s.name, description: s.description, content: s.content }));
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
        const parsed = this.parseSkillFile(content, dir);

        skills.push({
          id: `fs_${dir}`,
          name: dir,
          description: parsed.description,
          content,
          source: "filesystem",
          created_at: stat.birthtime.toISOString(),
          updated_at: stat.mtime.toISOString(),
        });
      } catch {
        continue;
      }
    }

    return skills;
  }

  private parseSkillFile(content: string, dirName: string): { description: string } {
    // Parse YAML frontmatter: ---\ndescription: "..."\n---
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
      if (descMatch) return { description: descMatch[1].trim() };
    }
    return { description: `Skill: ${dirName}` };
  }

  private mapRow(row: typeof schema.skills.$inferSelect): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
      source: row.source as "filesystem" | "uploaded",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

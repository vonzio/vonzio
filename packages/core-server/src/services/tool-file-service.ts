import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

export interface ToolFile {
  id: string;
  name: string;
  description: string | null;
  file_name: string;
  source: "filesystem" | "uploaded";
  code?: string;
  input_schema: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadToolInput {
  name: string;
  description?: string;
  file_name: string;
  code: string;
  input_schema?: string;
}

export class ToolFileService {
  constructor(
    private db: DrizzleDB,
    private toolsDir: string,
  ) {}

  async list(userId?: string): Promise<ToolFile[]> {
    const query = this.db.select().from(schema.toolFiles);
    const dbTools = userId
      ? await query.where(or(eq(schema.toolFiles.user_id, userId), isNull(schema.toolFiles.user_id)))
      : await query;
    const fsTools = this.scanFilesystem();

    // Merge: DB tools take priority over filesystem tools with same name
    const byName = new Map<string, ToolFile>();
    for (const t of fsTools) {
      // Strip code from list results for consistency (use get() or resolveTools() for code)
      byName.set(t.name, { ...t, code: undefined });
    }
    for (const row of dbTools) {
      byName.set(row.name, this.mapRow(row));
    }

    return Array.from(byName.values());
  }

  async get(id: string): Promise<ToolFile | null> {
    // Check DB first
    const rows = await this.db
      .select()
      .from(schema.toolFiles)
      .where(eq(schema.toolFiles.id, id));

    if (rows.length > 0) {
      return this.mapRow(rows[0], true);
    }

    // Check filesystem tools (ID = "fs_<name>")
    if (id.startsWith("fs_")) {
      const fsTools = this.scanFilesystem();
      return fsTools.find((t) => t.id === id) ?? null;
    }

    return null;
  }

  async getCode(id: string): Promise<string | null> {
    const tool = await this.get(id);
    if (!tool) return null;
    return tool.code ?? null;
  }

  async upload(input: UploadToolInput, userId?: string): Promise<ToolFile> {
    const id = `tool_${nanoid()}`;
    const now = new Date().toISOString();

    const row = {
      id,
      user_id: userId ?? null,
      name: input.name,
      description: input.description ?? null,
      file_name: input.file_name,
      source: "uploaded" as const,
      code: input.code,
      input_schema: input.input_schema ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.db.insert(schema.toolFiles).values(row);
    return this.mapRow(row, true);
  }

  async delete(id: string): Promise<boolean> {
    if (id.startsWith("fs_")) {
      return false; // Cannot delete filesystem tools
    }
    const result = await this.db
      .delete(schema.toolFiles)
      .where(eq(schema.toolFiles.id, id))
      .returning();
    return result.length > 0;
  }

  /** Resolve tool files by name for a given list of tool names. Returns name + code pairs. */
  async resolveTools(toolNames: string[]): Promise<{ name: string; code: string }[]> {
    // Single pass: scan filesystem (which includes code) + query DB with code
    const nameSet = new Set(toolNames);
    const results: { name: string; code: string }[] = [];

    // Filesystem tools already have code from scan
    const fsTools = this.scanFilesystem();
    for (const t of fsTools) {
      if (nameSet.has(t.name) && t.code) {
        results.push({ name: t.name, code: t.code });
        nameSet.delete(t.name);
      }
    }

    // For remaining names, query DB with code
    if (nameSet.size > 0) {
      const dbTools = await this.db.select().from(schema.toolFiles);
      for (const row of dbTools) {
        if (nameSet.has(row.name) && row.code) {
          results.push({ name: row.name, code: row.code });
          nameSet.delete(row.name);
        }
      }
    }

    return results;
  }

  scanFilesystem(): ToolFile[] {
    const tools: ToolFile[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(this.toolsDir);
    } catch {
      return tools; // Directory doesn't exist or isn't readable
    }
    for (const file of files) {
      if (!file.endsWith(".js") && !file.endsWith(".ts")) continue;

      const filePath = path.join(this.toolsDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const code = fs.readFileSync(filePath, "utf-8");
      const parsed = this.parseToolFile(code, file);

      tools.push({
        id: `fs_${parsed.name}`,
        name: parsed.name,
        description: parsed.description,
        file_name: file,
        source: "filesystem",
        code,
        input_schema: parsed.inputSchema,
        created_at: stat.birthtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
      });
    }

    return tools;
  }

  private parseToolFile(
    code: string,
    fileName: string,
  ): { name: string; description: string | null; inputSchema: string | null } {
    // Try to extract name, description, inputSchema from the module.exports pattern
    const nameMatch = code.match(/name:\s*["'`]([^"'`]+)["'`]/);
    const descMatch = code.match(/description:\s*["'`]([^"'`]+)["'`]/);

    // Extract inputSchema object (best-effort)
    let inputSchema: string | null = null;
    const schemaMatch = code.match(/inputSchema:\s*(\{[\s\S]*?\})\s*,?\s*(?:handler|$)/);
    if (schemaMatch) {
      inputSchema = schemaMatch[1];
    }

    const baseName = fileName.replace(/\.(js|ts)$/, "");

    return {
      name: nameMatch?.[1] ?? baseName,
      description: descMatch?.[1] ?? null,
      inputSchema,
    };
  }

  private mapRow(
    row: typeof schema.toolFiles.$inferSelect,
    includeCode = false,
  ): ToolFile {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      file_name: row.file_name,
      source: row.source as "filesystem" | "uploaded",
      code: includeCode ? (row.code ?? undefined) : undefined,
      input_schema: row.input_schema,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

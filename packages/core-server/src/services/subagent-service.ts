import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { SubagentDefinition } from "@vonzio/shared";

export interface Subagent {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSubagentInput {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

export class SubagentService {
  constructor(private db: DrizzleDB) {}

  async list(userId?: string): Promise<Subagent[]> {
    const query = this.db.select().from(schema.subagents);
    const rows = userId
      ? await query.where(or(eq(schema.subagents.user_id, userId), isNull(schema.subagents.user_id)))
      : await query;
    return rows.map(this.mapRow);
  }

  async get(id: string): Promise<Subagent | null> {
    const rows = await this.db.select().from(schema.subagents).where(eq(schema.subagents.id, id));
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(input: CreateSubagentInput, userId?: string): Promise<Subagent> {
    const id = `agent_${nanoid()}`;
    const now = new Date().toISOString();
    const row = {
      id,
      user_id: userId ?? null,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      tools: input.tools ?? null,
      model: input.model ?? null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(schema.subagents).values(row);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(schema.subagents).where(eq(schema.subagents.id, id)).returning();
    return result.length > 0;
  }

  /** Resolve agent IDs to the Record<name, AgentDefinition> format the SDK expects */
  async resolveAgents(agentIds: string[]): Promise<Record<string, SubagentDefinition>> {
    const all = await this.list();
    const result: Record<string, SubagentDefinition> = {};
    for (const id of agentIds) {
      const agent = all.find((a) => a.id === id);
      if (agent) {
        result[agent.name] = {
          description: agent.description,
          prompt: agent.prompt,
          tools: agent.tools,
          model: agent.model as SubagentDefinition["model"],
        };
      }
    }
    return result;
  }

  private mapRow(row: typeof schema.subagents.$inferSelect): Subagent {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      tools: row.tools ?? undefined,
      model: row.model ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

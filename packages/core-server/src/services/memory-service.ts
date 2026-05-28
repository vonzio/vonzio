import { eq, and, or, isNull, sql, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Memory, CreateMemoryInput, UpdateMemoryInput, SearchMemoryInput } from "@vonzio/shared";

const TYPE_PRIORITY: Record<string, number> = {
  feedback: 0,
  user: 1,
  project: 2,
  reference: 3,
};

export class MemoryService {
  constructor(private db: DrizzleDB) {}

  async create(userId: string, input: CreateMemoryInput, orgId?: string): Promise<Memory> {
    const id = `mem_${nanoid()}`;
    const now = new Date().toISOString();

    const row = {
      id,
      user_id: userId,
      // NULL in OSS / when no OrgContext was set. Stamping at create
      // time means every later read query can scope by org_id and
      // still find this row.
      org_id: orgId ?? null,
      profile_id: input.profile_id ?? null,
      type: input.type,
      name: input.name,
      description: input.description ?? null,
      body: input.body,
      importance: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: null,
    };

    await this.db.insert(schema.memories).values(row);
    return row as Memory;
  }

  async get(id: string, opts: { userId?: string; orgId?: string } = {}): Promise<Memory | null> {
    const conditions = [eq(schema.memories.id, id)];
    if (opts.userId) conditions.push(eq(schema.memories.user_id, opts.userId));
    if (opts.orgId) conditions.push(eq(schema.memories.org_id, opts.orgId));
    const rows = await this.db
      .select()
      .from(schema.memories)
      .where(and(...conditions));
    return (rows[0] as Memory) ?? null;
  }

  async list(
    userId: string,
    opts?: { type?: string; profileId?: string; allScopes?: boolean; limit?: number; offset?: number; orgId?: string },
  ): Promise<Memory[]> {
    const conditions = [eq(schema.memories.user_id, userId)];

    if (opts?.orgId) {
      // Defense in depth: require BOTH user_id and org_id to match.
      conditions.push(eq(schema.memories.org_id, opts.orgId));
    }

    if (opts?.type) {
      conditions.push(eq(schema.memories.type, opts.type as Memory["type"]));
    }

    if (!opts?.allScopes) {
      if (opts?.profileId) {
        conditions.push(
          or(
            eq(schema.memories.profile_id, opts.profileId),
            isNull(schema.memories.profile_id),
          )!,
        );
      } else {
        conditions.push(isNull(schema.memories.profile_id));
      }
    }

    const rows = await this.db
      .select()
      .from(schema.memories)
      .where(and(...conditions))
      .orderBy(desc(schema.memories.updated_at))
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0);

    return rows as Memory[];
  }

  async search(userId: string, input: SearchMemoryInput, orgId?: string): Promise<Memory[]> {
    const limit = input.limit ?? 10;
    const query = input.query;

    // Use ILIKE substring match for short queries (≤ 5 chars) — pg_trgm's
    // similarity() drops fast for short queries against long text and ends
    // up below the default 0.3 threshold, so prefix-typing like "Stag"
    // would never find "Staging dashboard…". ILIKE handles those reliably.
    // For longer queries (≥ 6 chars) trigram fuzz-matching earns its keep
    // (typos, partial words, etc.).
    const useIlike = query.length < 6;

    // Mirror list()'s allScopes-when-no-profile_id behaviour: when no
    // profile_id is supplied, search across every memory the user owns
    // regardless of scope. Previously this restricted to user-scoped only,
    // making profile-scoped memories invisible to search even though they
    // were visible in the regular list.
    const profileCondition = input.profile_id
      ? sql`AND (profile_id = ${input.profile_id} OR profile_id IS NULL)`
      : sql``;

    const typeCondition = input.type
      ? sql`AND type = ${input.type}`
      : sql``;

    // Org-scoping for raw-SQL search path: appended directly into the
    // WHERE clause. NULL on OSS / unscoped → no-op fragment.
    const orgCondition = orgId
      ? sql`AND org_id = ${orgId}`
      : sql``;

    let result;

    if (useIlike) {
      const pattern = `%${query}%`;
      result = await this.db.execute(sql`
        SELECT *
        FROM memories
        WHERE user_id = ${userId}
          ${profileCondition}
          ${typeCondition}
          ${orgCondition}
          AND (
            name ILIKE ${pattern} OR
            COALESCE(description, '') ILIKE ${pattern} OR
            body ILIKE ${pattern}
          )
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `);
    } else {
      result = await this.db.execute(sql`
        SELECT *,
          GREATEST(
            similarity(name, ${query}),
            similarity(COALESCE(description, ''), ${query}),
            similarity(body, ${query})
          ) AS score
        FROM memories
        WHERE user_id = ${userId}
          ${profileCondition}
          ${typeCondition}
          ${orgCondition}
          AND (
            name % ${query} OR
            COALESCE(description, '') % ${query} OR
            body % ${query}
          )
        ORDER BY score DESC, updated_at DESC
        LIMIT ${limit}
      `);
    }

    const memories = result.rows as unknown as Memory[];

    // Touch all returned memories (fire and forget)
    for (const m of memories) {
      this.touch(m.id);
    }

    return memories;
  }

  async update(id: string, userId: string, input: UpdateMemoryInput, orgId?: string): Promise<Memory | null> {
    const conditions = [eq(schema.memories.id, id), eq(schema.memories.user_id, userId)];
    if (orgId) conditions.push(eq(schema.memories.org_id, orgId));
    const existing = await this.db
      .select()
      .from(schema.memories)
      .where(and(...conditions));

    if (existing.length === 0) return null;

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.type !== undefined) updates.type = input.type;
    if (input.body !== undefined) updates.body = input.body;
    if (input.description !== undefined) updates.description = input.description;
    updates.updated_at = new Date().toISOString();

    await this.db
      .update(schema.memories)
      .set(updates)
      .where(eq(schema.memories.id, id));

    return this.get(id);
  }

  async delete(id: string, userId: string, orgId?: string): Promise<boolean> {
    const conditions = [eq(schema.memories.id, id), eq(schema.memories.user_id, userId)];
    if (orgId) conditions.push(eq(schema.memories.org_id, orgId));
    const result = await this.db
      .delete(schema.memories)
      .where(and(...conditions))
      .returning();
    return result.length > 0;
  }

  async bulkDelete(userId: string, opts?: { type?: string; profileId?: string; orgId?: string }): Promise<number> {
    const conditions = [eq(schema.memories.user_id, userId)];

    if (opts?.orgId) {
      conditions.push(eq(schema.memories.org_id, opts.orgId));
    }
    if (opts?.type) {
      conditions.push(eq(schema.memories.type, opts.type as Memory["type"]));
    }
    if (opts?.profileId) {
      conditions.push(eq(schema.memories.profile_id, opts.profileId));
    }

    const result = await this.db
      .delete(schema.memories)
      .where(and(...conditions))
      .returning();
    return result.length;
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(schema.memories)
      .set({
        last_accessed_at: new Date().toISOString(),
        importance: sql`${schema.memories.importance} + 1`,
      })
      .where(eq(schema.memories.id, id));
  }

  async getTopMemories(
    userId: string,
    profileId?: string,
    tokenBudget: number = 500,
  ): Promise<Memory[]> {
    const conditions = [eq(schema.memories.user_id, userId)];

    if (profileId) {
      conditions.push(
        or(
          eq(schema.memories.profile_id, profileId),
          isNull(schema.memories.profile_id),
        )!,
      );
    } else {
      conditions.push(isNull(schema.memories.profile_id));
    }

    const candidates = await this.db
      .select()
      .from(schema.memories)
      .where(and(...conditions))
      .orderBy(desc(schema.memories.importance), desc(schema.memories.updated_at))
      .limit(30);

    // Sort by type priority, then importance DESC, then updated_at DESC
    const sorted = (candidates as Memory[]).sort((a, b) => {
      const typeDiff = (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updated_at.localeCompare(a.updated_at);
    });

    const packed: Memory[] = [];
    let usedTokens = 0;

    for (const mem of sorted) {
      const text = `${mem.name}: ${mem.body}`;
      const tokens = Math.ceil(text.length / 4);
      if (usedTokens + tokens > tokenBudget) continue;
      packed.push(mem);
      usedTokens += tokens;
    }

    // Touch all returned memories (fire and forget)
    for (const m of packed) {
      this.touch(m.id);
    }

    return packed;
  }
}

import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Task, TaskAttachment, TaskMode, TaskStatus, TaskPriority } from "@vonzio/shared";
import type { TaskQueue } from "@vonzio/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ProfileService } from "./profile-service.js";
import { ForbiddenError, NotFoundError } from "../errors.js";

export interface SubmitTaskInput {
  mode?: TaskMode;
  prompt: string;
  profile_id?: string;
  session_id?: string;
  allowed_tools?: string[];
  output_schema?: Record<string, unknown>;
  workspace?: Task["workspace"];
  claude_md?: string;
  egress_domains?: string[];
  priority?: TaskPriority;
  max_turns?: number;
  max_budget_usd?: number;
  model?: string;
  effort?: string;
  timeout_seconds?: number;
  attachments?: TaskAttachment[];

  retry?: Task["retry"];
}

export interface TaskFilters {
  profileIds?: string[];
  sessionId?: string;
  status?: TaskStatus;
  mode?: TaskMode;
  page?: number;
  limit?: number;
}

export class TaskService {
  constructor(
    private db: DrizzleDB,
    private queue: TaskQueue,
    private orchestrator: Orchestrator,
    private profileService?: ProfileService,
  ) {}

  async submit(
    input: SubmitTaskInput,
    callerProfileIds: string[],
  ): Promise<{ task_id: string; status: string; created_at: string }> {
    // Auto-resolve profile_id: if omitted and caller has exactly one profile, use it
    let profileId = input.profile_id;
    if (!profileId) {
      if (callerProfileIds.length === 1) {
        profileId = callerProfileIds[0];
      } else {
        throw new ForbiddenError(
          "profile_id is required when caller has access to multiple profiles",
        );
      }
    }

    if (!callerProfileIds.includes(profileId)) {
      throw new ForbiddenError(
        `Caller does not have access to profile ${profileId}`,
      );
    }

    // Merge profile defaults into task
    let mergedTools = input.allowed_tools;
    let mergedEgress = input.egress_domains;
    let mergedClaudeMd = input.claude_md;

    if (this.profileService) {
      const profile = await this.profileService.get(profileId);
      if (profile) {
        // Tools: use task-level if specified, else profile defaults
        if (!mergedTools?.length && profile.default_tools?.length) {
          mergedTools = profile.default_tools;
        }

        // Egress: union of profile defaults + task overrides
        const credEgress = profile.default_egress_domains ?? [];
        const taskEgress = input.egress_domains ?? [];
        const combined = [...new Set([...credEgress, ...taskEgress])];
        mergedEgress = combined.length > 0 ? combined : undefined;

        // CLAUDE.md: concatenate profile + task (if both exist)
        if (profile.claude_md && mergedClaudeMd) {
          mergedClaudeMd = profile.claude_md + "\n\n---\n\n" + mergedClaudeMd;
        } else if (profile.claude_md) {
          mergedClaudeMd = profile.claude_md;
        }
      }
    }

    const id = `task_${nanoid()}`;
    const now = new Date().toISOString();
    const mode = input.mode ?? "pooled";

    const task: Task = {
      id,
      mode,
      status: "queued",
      prompt: input.prompt,
      profile_id: profileId,
      session_id: input.session_id,
      allowed_tools: mergedTools,
      output_schema: input.output_schema,
      workspace: input.workspace,
      claude_md: mergedClaudeMd,
      egress_domains: mergedEgress,
      priority: input.priority ?? "normal",
      max_turns: input.max_turns,
      max_budget_usd: input.max_budget_usd,
      model: input.model,
      effort: input.effort,
      timeout_seconds: input.timeout_seconds,
      retry: input.retry,
      attachments: input.attachments,
      created_at: now,
      attempt: 1,
    };

    await this.db
      .insert(schema.tasks)
      .values({
        ...task,
        session_id: task.session_id ?? null,
        allowed_tools: task.allowed_tools ?? null,
        output_schema: task.output_schema ?? null,
        workspace: task.workspace ?? null,
        claude_md: task.claude_md ?? null,
        egress_domains: task.egress_domains ?? null,
        max_turns: task.max_turns ?? null,
        max_budget_usd: task.max_budget_usd ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
        timeout_seconds: task.timeout_seconds ?? null,
        retry: task.retry ?? null,
        started_at: null,
        finished_at: null,
        cancelled_at: null,
        result: null,
        error: null,
      });

    await this.queue.enqueue(task);

    return { task_id: id, status: "queued", created_at: now };
  }

  async get(taskId: string): Promise<Task | null> {
    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));

    if (rows.length === 0) return null;
    return this.rowToTask(rows[0]);
  }

  async list(filters: TaskFilters = {}): Promise<{ tasks: Task[]; total: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (filters.profileIds?.length) {
      conditions.push(inArray(schema.tasks.profile_id, filters.profileIds));
    }
    if (filters.sessionId) {
      conditions.push(eq(schema.tasks.session_id, filters.sessionId));
    }
    if (filters.status) {
      conditions.push(eq(schema.tasks.status, filters.status));
    }
    if (filters.mode) {
      conditions.push(eq(schema.tasks.mode, filters.mode));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(where)
      .orderBy(desc(schema.tasks.created_at))
      .limit(limit)
      .offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(where);

    return {
      tasks: rows.map((r) => this.rowToTask(r)),
      total: countResult[0]?.count ?? 0,
    };
  }

  async cancel(taskId: string): Promise<boolean> {
    return this.orchestrator.cancelTask(taskId);
  }

  private rowToTask(row: typeof schema.tasks.$inferSelect): Task {
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      prompt: row.prompt,
      profile_id: row.profile_id,
      session_id: row.session_id ?? undefined,
      allowed_tools: row.allowed_tools ?? undefined,
      output_schema: row.output_schema ?? undefined,
      workspace: row.workspace ?? undefined,
      claude_md: row.claude_md ?? undefined,
      egress_domains: row.egress_domains ?? undefined,
      priority: row.priority,
      max_turns: row.max_turns ?? undefined,
      max_budget_usd: row.max_budget_usd ?? undefined,
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      timeout_seconds: row.timeout_seconds ?? undefined,
      retry: row.retry ?? undefined,
      created_at: row.created_at,
      started_at: row.started_at ?? undefined,
      finished_at: row.finished_at ?? undefined,
      cancelled_at: row.cancelled_at ?? undefined,
      attempt: row.attempt,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

export { ForbiddenError, NotFoundError } from "../errors.js";

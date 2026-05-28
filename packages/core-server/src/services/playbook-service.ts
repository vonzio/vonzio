import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleDB } from "../db/index.js";
import * as schema from "../db/schema.js";
import type { Playbook, PlaybookRun, PlaybookChainConfig, ActivityLogEntry, NotifyOn, TriggerType, SuccessCriterion, DecisionResult, PlaybookTerminationReason } from "@vonzio/shared";
import { DEFAULT_CHAIN_CONFIG } from "@vonzio/shared";
import type { IntegrationService } from "./integration-service.js";

export interface CreatePlaybookInput {
  profile_id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule: string;
  chain_config?: Partial<PlaybookChainConfig>;
  enabled?: boolean;
  notify_on?: NotifyOn;
  notification_channels?: string[];
  trigger_type?: TriggerType;
  interval_seconds?: number;
  webhook_token?: string;
  success_criteria?: SuccessCriterion[];
}

export class PlaybookService {
  constructor(private db: DrizzleDB, private integrationService: IntegrationService) {}

  // Validate any "telegram:<integration_id>" entries in notification_channels:
  // the referenced integration must exist, be type=telegram, and belong to the
  // playbook owner. Rejects stale ids surviving after a bot is deleted, and
  // blocks cross-user id smuggling.
  private async validateChannels(userId: string, channels: string[]): Promise<void> {
    const ids = channels
      .filter((c) => c.startsWith("telegram:"))
      .map((c) => c.slice("telegram:".length));
    if (ids.length === 0) return;
    if (ids.some((id) => !id)) {
      throw new Error("Invalid Telegram channel: missing integration id");
    }
    const integrations = await Promise.all(ids.map((id) => this.integrationService.get(id)));
    integrations.forEach((integration, i) => {
      if (!integration || integration.user_id !== userId || integration.type !== "telegram") {
        throw new Error(`Telegram bot ${ids[i]} not found or not yours`);
      }
    });
  }

  async list(userId: string): Promise<Playbook[]> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(eq(schema.playbooks.user_id, userId))
      .orderBy(desc(schema.playbooks.created_at));
    return rows.map((r) => this.mapPlaybook(r));
  }

  async get(id: string): Promise<Playbook | null> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(eq(schema.playbooks.id, id));
    return rows.length > 0 ? this.mapPlaybook(rows[0]) : null;
  }

  async create(userId: string, input: CreatePlaybookInput): Promise<Playbook> {
    if (input.notification_channels !== undefined) {
      await this.validateChannels(userId, input.notification_channels);
    }
    const id = `pb_${nanoid()}`;
    const now = new Date().toISOString();
    const chainConfig: PlaybookChainConfig = {
      ...DEFAULT_CHAIN_CONFIG,
      ...input.chain_config,
    };
    // Enforce bounds
    chainConfig.max_chains = Math.min(Math.max(chainConfig.max_chains, 1), 20);
    chainConfig.budget_cap_usd = Math.min(Math.max(chainConfig.budget_cap_usd, 0.1), 100);
    chainConfig.chain_delay_ms = Math.min(Math.max(chainConfig.chain_delay_ms, 1000), 60000);
    if (chainConfig.max_turns_per_chain !== undefined) {
      chainConfig.max_turns_per_chain = Math.min(Math.max(chainConfig.max_turns_per_chain, 5), 200);
    }
    const row = {
      id,
      user_id: userId,
      profile_id: input.profile_id,
      name: input.name,
      description: input.description ?? "",
      prompt: input.prompt,
      schedule: input.schedule,
      chain_config: chainConfig,
      enabled: input.enabled ?? false,
      notify_on: input.notify_on ?? "none",
      notification_channels: input.notification_channels ?? [],
      trigger_type: input.trigger_type ?? "cron",
      interval_seconds: input.interval_seconds ?? null,
      webhook_token: input.webhook_token ?? null,
      success_criteria: input.success_criteria ?? null,
      last_run_at: null,
      next_run_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(schema.playbooks).values(row);
    return this.mapPlaybook(row);
  }

  async update(
    id: string,
    userId: string,
    input: Partial<CreatePlaybookInput> & { enabled?: boolean },
  ): Promise<Playbook | null> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(and(eq(schema.playbooks.id, id), eq(schema.playbooks.user_id, userId)));
    if (rows.length === 0) return null;

    if (input.notification_channels !== undefined) {
      await this.validateChannels(userId, input.notification_channels);
    }

    const existing = rows[0];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    if (input.profile_id !== undefined) updates.profile_id = input.profile_id;
    if (input.schedule !== undefined) updates.schedule = input.schedule;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.chain_config !== undefined) {
      updates.chain_config = { ...DEFAULT_CHAIN_CONFIG, ...(existing.chain_config as PlaybookChainConfig), ...input.chain_config };
    }
    if (input.notify_on !== undefined) updates.notify_on = input.notify_on;
    if (input.notification_channels !== undefined) updates.notification_channels = input.notification_channels;
    if (input.trigger_type !== undefined) updates.trigger_type = input.trigger_type;
    if (input.interval_seconds !== undefined) updates.interval_seconds = input.interval_seconds;
    if (input.webhook_token !== undefined) updates.webhook_token = input.webhook_token;
    if (input.success_criteria !== undefined) updates.success_criteria = input.success_criteria;

    await this.db.update(schema.playbooks).set(updates).where(eq(schema.playbooks.id, id));

    const updated = await this.db.select().from(schema.playbooks).where(eq(schema.playbooks.id, id));
    return updated.length > 0 ? this.mapPlaybook(updated[0]) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(and(eq(schema.playbooks.id, id), eq(schema.playbooks.user_id, userId)));
    if (rows.length === 0) return false;

    await this.db.delete(schema.playbookRuns).where(eq(schema.playbookRuns.playbook_id, id));
    await this.db.delete(schema.playbooks).where(eq(schema.playbooks.id, id));
    return true;
  }

  async setNextRunAt(id: string, nextRunAt: string | null): Promise<void> {
    await this.db.update(schema.playbooks).set({ next_run_at: nextRunAt }).where(eq(schema.playbooks.id, id));
  }

  async setLastRunAt(id: string, lastRunAt: string): Promise<void> {
    await this.db.update(schema.playbooks).set({ last_run_at: lastRunAt, updated_at: new Date().toISOString() }).where(eq(schema.playbooks.id, id));
  }

  async getByWebhookToken(token: string): Promise<Playbook | null> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(eq(schema.playbooks.webhook_token, token));
    return rows.length > 0 ? this.mapPlaybook(rows[0]) : null;
  }

  async listAllEnabled(): Promise<Playbook[]> {
    const rows = await this.db
      .select()
      .from(schema.playbooks)
      .where(eq(schema.playbooks.enabled, true));
    return rows.map((r) => this.mapPlaybook(r));
  }

  // ── Run management ──

  async createRun(playbookId: string, userId: string, sessionId: string): Promise<PlaybookRun> {
    const id = `pbr_${nanoid()}`;
    const now = new Date().toISOString();
    const row = {
      id,
      playbook_id: playbookId,
      user_id: userId,
      session_id: sessionId,
      status: "running" as const,
      chain_count: 0,
      total_turns: 0,
      total_cost_usd: 0,
      task_ids: [] as string[],
      result_summary: null,
      activity_log: null,
      decision_result: null,
      termination_reason: null,
      error: null,
      started_at: now,
      finished_at: null,
    };
    await this.db.insert(schema.playbookRuns).values(row);
    return this.mapRun(row);
  }

  async updateRun(id: string, updates: Partial<{
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    chain_count: number;
    total_turns: number;
    total_cost_usd: number;
    task_ids: string[];
    result_summary: string;
    activity_log: ActivityLogEntry[];
    decision_result: DecisionResult;
    termination_reason: PlaybookTerminationReason;
    error: string;
    finished_at: string;
  }>): Promise<void> {
    await this.db.update(schema.playbookRuns).set(updates).where(eq(schema.playbookRuns.id, id));
  }

  async getRun(id: string): Promise<PlaybookRun | null> {
    const rows = await this.db
      .select()
      .from(schema.playbookRuns)
      .where(eq(schema.playbookRuns.id, id));
    return rows.length > 0 ? this.mapRun(rows[0]) : null;
  }

  async listRuns(playbookId: string, limit = 20): Promise<PlaybookRun[]> {
    const rows = await this.db
      .select()
      .from(schema.playbookRuns)
      .where(eq(schema.playbookRuns.playbook_id, playbookId))
      .orderBy(desc(schema.playbookRuns.started_at))
      .limit(limit);
    return rows.map((r) => this.mapRun(r));
  }

  async listRunsForUser(userId: string, limit = 50, playbookId?: string): Promise<PlaybookRun[]> {
    const conditions = [eq(schema.playbookRuns.user_id, userId)];
    if (playbookId) conditions.push(eq(schema.playbookRuns.playbook_id, playbookId));
    const rows = await this.db
      .select({
        run: schema.playbookRuns,
        playbook_name: schema.playbooks.name,
      })
      .from(schema.playbookRuns)
      .leftJoin(schema.playbooks, eq(schema.playbookRuns.playbook_id, schema.playbooks.id))
      .where(and(...conditions))
      .orderBy(desc(schema.playbookRuns.started_at))
      .limit(limit);
    return rows.map((r) => ({ ...this.mapRun(r.run), playbook_name: r.playbook_name ?? undefined }));
  }

  // ── Mappers ──

  private mapPlaybook(row: Omit<typeof schema.playbooks.$inferSelect, "org_id">): Playbook {
    return {
      id: row.id,
      user_id: row.user_id,
      profile_id: row.profile_id,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      schedule: row.schedule,
      chain_config: (row.chain_config as PlaybookChainConfig) ?? DEFAULT_CHAIN_CONFIG,
      enabled: row.enabled,
      notify_on: (row.notify_on as NotifyOn) ?? "none",
      notification_channels: (row.notification_channels as string[]) ?? [],
      trigger_type: (row.trigger_type as TriggerType) ?? "cron",
      interval_seconds: row.interval_seconds ?? undefined,
      webhook_token: row.webhook_token ?? undefined,
      success_criteria: (row.success_criteria as SuccessCriterion[]) ?? undefined,
      last_run_at: row.last_run_at ?? undefined,
      next_run_at: row.next_run_at ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapRun(row: typeof schema.playbookRuns.$inferSelect): PlaybookRun {
    return {
      id: row.id,
      playbook_id: row.playbook_id,
      user_id: row.user_id,
      session_id: row.session_id,
      status: row.status as PlaybookRun["status"],
      chain_count: row.chain_count,
      total_turns: row.total_turns,
      total_cost_usd: row.total_cost_usd,
      task_ids: (row.task_ids as string[]) ?? [],
      result_summary: row.result_summary ?? undefined,
      activity_log: (row.activity_log as ActivityLogEntry[]) ?? undefined,
      decision_result: (row.decision_result as DecisionResult) ?? undefined,
      termination_reason: (row.termination_reason as PlaybookTerminationReason) ?? undefined,
      error: row.error ?? undefined,
      started_at: row.started_at,
      finished_at: row.finished_at ?? undefined,
    };
  }
}

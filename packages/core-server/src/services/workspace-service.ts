import { eq, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { SessionRegistry } from "../container/session-registry.js";
import type { ContainerManager } from "@vonzio/shared";
import type { Workspace, WorkspaceStatus } from "@vonzio/shared";

export interface WorkspaceFilters {
  userId?: string;
  status?: WorkspaceStatus;
  /** Default true; pass false to hide archived workspaces. */
  includeArchived?: boolean;
  /** When true, only return starred workspaces. */
  starredOnly?: boolean;
  page?: number;
  limit?: number;
}

export class WorkspaceService {
  constructor(
    private db: DrizzleDB,
    private registry: SessionRegistry,
    private containerManager: ContainerManager,
  ) {}

  get(sessionId: string): Workspace | null {
    return this.registry.get(sessionId);
  }

  async list(filters: WorkspaceFilters = {}): Promise<{ workspaces: Workspace[]; total: number }> {
    let all: Workspace[];
    if (filters.userId) {
      all = filters.status
        ? this.registry.listByUserAndStatus(filters.userId, filters.status)
        : this.registry.listByUser(filters.userId);
    } else {
      all = filters.status
        ? this.registry.listByStatus(filters.status)
        : this.registry.listAll();
    }

    // Merge in expired workspaces from the DB. The registry deletes
    // expired sessions from its in-memory map (to bound memory) so
    // without this the API hides them entirely — bug the user reported
    // on v0.1.81 where 91 expired workspaces were invisible. Skip the
    // DB query when the caller asked for a non-expired status filter
    // (no expired rows would match anyway, save the round-trip).
    if (!filters.status || filters.status === "expired") {
      const inactive = await this.registry.listInactiveFromDB(filters.userId);
      all = all.concat(inactive);
    }

    // Exclude playbook-execution workspaces (session_id starts with "pb-")
    // from the chat list UNLESS the user has actively engaged with them.
    // "Engaged" = there's a telegram_playbook_threads row with
    // claimed_at IS NOT NULL pointing at this session — meaning the user
    // tapped "Reply here" or auto-claimed by typing a reply (feature #18).
    // Without this carve-out, claimed playbook conversations would still
    // be invisible to the user even though they actively continue them
    // via Telegram.
    const claimedPbSessions = new Set<string>(
      (await this.db.select({ s: schema.telegramPlaybookThreads.session_id })
        .from(schema.telegramPlaybookThreads)
        .where(isNotNull(schema.telegramPlaybookThreads.claimed_at)))
        .map((r) => r.s),
    );
    all = all.filter((w) => !w.session_id.startsWith("pb-") || claimedPbSessions.has(w.session_id));

    // Optional flag-based filters (default behavior unchanged: archived included, all stars).
    if (filters.includeArchived === false) {
      all = all.filter((w) => !w.archived);
    }
    if (filters.starredOnly) {
      all = all.filter((w) => w.starred);
    }

    // Sort by last_active_at descending so newest sessions always appear first
    all.sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 200;
    const offset = (page - 1) * limit;

    return {
      workspaces: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  async update(sessionId: string, fields: { name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; model_override?: string | null; last_run_model?: string | null }): Promise<Workspace | null> {
    // Expired sessions live only in the DB (SessionRegistry deletes them
    // from its in-memory Map on reap). The old early-return here meant
    // the user couldn't change `model_override`, `name`, `starred`, etc.
    // on a session listed under Earlier in the sidebar. Allow metadata
    // updates against the DB row even when the in-memory session is gone.
    const workspace = this.registry.get(sessionId);

    if (workspace) {
      if (fields.name !== undefined) workspace.name = fields.name;
      if (fields.starred !== undefined) workspace.starred = fields.starred;
      if (fields.pinned !== undefined) workspace.pinned = fields.pinned;
      if (fields.archived !== undefined) workspace.archived = fields.archived;
      if (fields.tags !== undefined) workspace.tags = fields.tags;
      if (fields.public_preview !== undefined) workspace.public_preview = fields.public_preview;
      if (fields.model_override !== undefined) workspace.model_override = fields.model_override;
      if (fields.last_run_model !== undefined) workspace.last_run_model = fields.last_run_model;
    }

    const dbUpdate: Record<string, unknown> = {};
    if (fields.name !== undefined) dbUpdate.name = fields.name;
    if (fields.starred !== undefined) dbUpdate.starred = fields.starred;
    if (fields.pinned !== undefined) dbUpdate.pinned = fields.pinned;
    if (fields.archived !== undefined) dbUpdate.archived = fields.archived;
    if (fields.tags !== undefined) dbUpdate.tags = fields.tags;
    if (fields.public_preview !== undefined) dbUpdate.public_preview = fields.public_preview;
    if (fields.model_override !== undefined) dbUpdate.model_override = fields.model_override;
    if (fields.last_run_model !== undefined) dbUpdate.last_run_model = fields.last_run_model;

    if (Object.keys(dbUpdate).length > 0) {
      const result = await this.db
        .update(schema.workspaces)
        .set(dbUpdate)
        .where(eq(schema.workspaces.session_id, sessionId))
        .returning();
      // If the in-memory session was gone (expired) we still want the
      // dashboard to see the updated row reflected — load it from the
      // DB return value via listInactiveFromDB's shape. Cheaper: just
      // pick one of the rows we mutated.
      if (!workspace && result.length > 0) {
        const row = result[0];
        return {
          session_id: row.session_id,
          container_id: row.container_id,
          user_id: row.user_id ?? "",
          profile_id: row.profile_id,
          name: row.name ?? null,
          pinned: row.pinned,
          starred: row.starred,
          tags: row.tags,
          archived: row.archived,
          last_opened_at: row.last_opened_at ?? null,
          persistent: row.persistent,
          volume_id: row.volume_id ?? null,
          volume_expires_at: row.volume_expires_at ?? null,
          public_preview: row.public_preview,
          model_override: row.model_override ?? null,
          last_run_model: row.last_run_model ?? null,
          status: row.status as WorkspaceStatus,
          last_active_at: row.last_active_at,
          created_at: row.created_at,
          expires_at: row.expires_at,
        };
      }
    }

    return workspace;
  }

  async terminate(sessionId: string): Promise<boolean> {
    const session = this.registry.get(sessionId);
    if (!session) return false;

    if (session.container_id) {
      try {
        await this.containerManager.removeContainer(session.container_id, true);
      } catch {
        // Container may already be gone
      }
    }

    this.registry.setStatus(sessionId, "expired");
    this.registry.remove(sessionId);
    return true;
  }
}

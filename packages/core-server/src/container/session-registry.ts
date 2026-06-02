import { eq, and, isNotNull, lte, inArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Workspace, WorkspaceStatus } from "@vonzio/shared";
import type { ContainerManager } from "@vonzio/shared";
import { getActiveOrgId } from "../lib/active-org.js";

export interface SessionRegistryCallbacks {
  onIdleExpiry: (sessionId: string, containerId: string) => Promise<void>;
  onIdlePause: (sessionId: string, containerId: string) => Promise<void>;
  onExpired: (sessionId: string) => Promise<void>;
}

export interface SessionRegistryConfig {
  idleTtlSecs: number;
  maxLifetimeSecs: number;
  workstationIdlePauseSecs: number;
  workstationMaxLifetimeSecs: number;
  maxPaused: number;
  volumeTtlDays: number;
}

interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export const VOLUME_PREFIX_WORKSPACE = "vonzio-ws-";
export const VOLUME_PREFIX_SDK = "vonzio-sdk-";

export class SessionRegistry {
  private sessions = new Map<string, Workspace>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private containerManager: ContainerManager | null = null;
  /** Callback to get session IDs with live WS connections. Injected by server. */
  getConnectedSessionIds: () => Set<string> = () => new Set();

  constructor(
    private config: SessionRegistryConfig,
    private callbacks: SessionRegistryCallbacks,
    private db: DrizzleDB,
    private log: Logger = noopLogger,
  ) {}

  start(): void {
    this.checkInterval = setInterval(() => this.sweep(), 30_000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.containerManager = null;
  }

  async register(
    sessionId: string,
    containerId: string | null,
    userId: string,
    profileId: string,
    persistent = false,
    orgId: string | null = null,
  ): Promise<Workspace> {
    // Fall back to the AsyncLocalStorage-pinned active org so callers
    // running inside a request/connection scope don't have to thread
    // org_id through every layer. cp-server populates it via its
    // permissive middleware (HTTP) and the WS message handler wraps
    // dispatch in runWithOrgId (WS + orchestrator). OSS deployments
    // never set the storage so this fallback is null — existing
    // behavior. See packages/core-server/src/lib/active-org.ts.
    const effectiveOrgId = orgId ?? getActiveOrgId();
    const now = new Date().toISOString();
    const lifetimeSecs = persistent
      ? this.config.workstationMaxLifetimeSecs
      : this.config.maxLifetimeSecs;
    const expiresAt = new Date(
      Date.now() + lifetimeSecs * 1000,
    ).toISOString();

    const session: Workspace = {
      session_id: sessionId,
      container_id: containerId,
      user_id: userId,
      org_id: effectiveOrgId,
      profile_id: profileId,
      name: null,
      pinned: false,
      starred: false,
      tags: [],
      archived: false,
      last_opened_at: null,
      persistent,
      volume_id: null,
      volume_expires_at: null,
      public_preview: false,
      model_override: null,
      last_run_model: null,
      status: "active",
      last_active_at: now,
      created_at: now,
      expires_at: expiresAt,
    };

    this.sessions.set(sessionId, session);

    await this.db
      .insert(schema.workspaces)
      .values({
        session_id: sessionId,
        container_id: containerId,
        user_id: userId,
        org_id: effectiveOrgId,
        profile_id: profileId,
        persistent,
        status: "active",
        last_active_at: now,
        created_at: now,
        expires_at: expiresAt,
      });

    return session;
  }

  get(sessionId: string): Workspace | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getByContainer(containerId: string): Workspace | null {
    for (const session of this.sessions.values()) {
      if (session.container_id === containerId) return session;
    }
    return null;
  }

  async updateActivity(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      const now = new Date().toISOString();
      session.last_active_at = now;
      session.status = "active";

      await this.db
        .update(schema.workspaces)
        .set({ last_active_at: now, status: "active" })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  async setStatus(sessionId: string, status: WorkspaceStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      if (status === "resumable") {
        session.container_id = null;
      }

      const dbUpdate: Record<string, unknown> = { status };
      if (status === "resumable") {
        dbUpdate.container_id = null;
      }
      await this.db
        .update(schema.workspaces)
        .set(dbUpdate)
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  async extendExpiry(sessionId: string, expiresAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.expires_at = expiresAt;
      await this.db
        .update(schema.workspaces)
        .set({ expires_at: expiresAt })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  async setContainerId(sessionId: string, containerId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.container_id = containerId;
      await this.db
        .update(schema.workspaces)
        .set({ container_id: containerId })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  /** Set container ID and status to active in a single DB write. */
  async reassignContainer(sessionId: string, containerId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.container_id = containerId;
      session.status = "active";
      await this.db
        .update(schema.workspaces)
        .set({ container_id: containerId, status: "active" as WorkspaceStatus })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  /** Drop the container pointer so the next dispatch hits the
   *  resurrection path. Used when an external trigger (e.g. tunnel
   *  override applied mid-session) needs to force a fresh container
   *  without destroying the workspace itself. */
  async clearContainer(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.container_id = null;
      session.status = "resumable";
      await this.db
        .update(schema.workspaces)
        .set({ container_id: null, status: "resumable" as WorkspaceStatus })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  async setVolumeId(sessionId: string, volumeId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.volume_id = volumeId;
      await this.db
        .update(schema.workspaces)
        .set({ volume_id: volumeId })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  /**
   * Record the model that just ran a turn, so the next turn can detect a
   * cross-model switch and trigger transcript replay (the SDK's resume
   * doesn't carry context across model identity changes).
   */
  async setLastRunModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.last_run_model = model;
      await this.db
        .update(schema.workspaces)
        .set({ last_run_model: model })
        .where(eq(schema.workspaces.session_id, sessionId));
    }
  }

  setWsConnection(sessionId: string, wsConnectionId: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      (session as unknown as Record<string, unknown>).ws_connection_id = wsConnectionId;
    }
  }

  listAll(): Workspace[] {
    return Array.from(this.sessions.values());
  }

  listByUser(userId: string): Workspace[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.user_id === userId,
    );
  }

  listByUserAndStatus(userId: string, status: WorkspaceStatus): Workspace[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.user_id === userId && s.status === status,
    );
  }

  listByStatus(status: WorkspaceStatus): Workspace[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === status,
    );
  }

  /**
   * Bring an expired session back into the live in-memory Map so the
   * orchestrator's normal task-dispatch path (which expects the session
   * to be in memory) will provision a fresh container for the next
   * task. Status transitions expired → resumable; container_id stays
   * null until the orchestrator creates a new one on the first task.
   *
   * Returns the resurrected workspace, or null if there's no row for
   * the given session id (or it belongs to a different user). No-ops
   * with the existing in-memory session if the session is already
   * live (idempotent — safe to call defensively).
   *
   * The persistent volume may have been reaped already (per
   * volume_ttl_days); we don't check, because re-running with no
   * volume is the user's choice. The container will start fresh
   * either way.
   */
  async resurrect(sessionId: string, userId: string): Promise<Workspace | null> {
    const live = this.sessions.get(sessionId);
    if (live) return live;

    const rows = await this.db.select().from(schema.workspaces).where(
      and(eq(schema.workspaces.session_id, sessionId), eq(schema.workspaces.user_id, userId)),
    );
    if (rows.length === 0) return null;
    const row = rows[0];

    const session: Workspace = {
      session_id: row.session_id,
      container_id: null,
      user_id: row.user_id ?? "",
      org_id: row.org_id ?? null,
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
      status: "resumable",
      last_active_at: new Date().toISOString(),
      created_at: row.created_at,
      expires_at: row.expires_at,
      // The container will be created fresh by the orchestrator on the
      // first task. The SDK's session storage is on disk inside the
      // container — that's gone with the reaped container. Flag the
      // session so the orchestrator rebuilds context from EventLog and
      // prefixes it to the user's next prompt. Without this, the agent
      // wakes up with no memory of the prior conversation.
      needs_context_replay: true,
    };
    this.sessions.set(sessionId, session);
    await this.db
      .update(schema.workspaces)
      .set({ status: "resumable", container_id: null, last_active_at: session.last_active_at })
      .where(eq(schema.workspaces.session_id, sessionId));
    this.log.info({ sessionId, userId }, "Expired session resurrected (will replay EventLog on next task)");
    return session;
  }

  /**
   * Fetch workspaces that exist in the DB but NOT in the in-memory
   * sessions map. Specifically: rows whose status was set to `expired`
   * (or any other "drop from memory" terminal state) when the session
   * was reaped. Without this, `listByUser` returns only LIVE sessions
   * and 91 expired rows for the admin user were silently invisible to
   * the API — the exact bug the user hit on v0.1.81.
   *
   * Always hits the DB (one query). Caller decides whether to call it
   * (i.e., the sidebar's "history" view does; hot per-request paths
   * that only need live sessions can skip it).
   */
  async listInactiveFromDB(userId?: string, orgId?: string): Promise<Workspace[]> {
    // Build the WHERE clause dynamically: status=expired is required;
    // user_id and org_id stack when supplied. The org filter is done
    // server-side so the SaaS workspace list doesn't pull rows from
    // other tenants over the wire and then JS-filter them out.
    const conditions = [eq(schema.workspaces.status, "expired")];
    if (userId) conditions.push(eq(schema.workspaces.user_id, userId));
    if (orgId) conditions.push(eq(schema.workspaces.org_id, orgId));

    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(and(...conditions));

    return rows
      .filter((row) => !this.sessions.has(row.session_id))
      .map((row): Workspace => ({
        session_id: row.session_id,
        container_id: row.container_id,
        user_id: row.user_id ?? "",
        org_id: row.org_id ?? null,
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
      }));
  }

  async remove(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const volumeId = session?.volume_id ?? undefined;
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      await this.markExpiredInDB(sessionId, false, volumeId);
    }
    return deleted;
  }

  /** Returns a map of container ID → session ID for all sessions with assigned containers */
  get containerSessionMap(): Map<string, string> {
    const result = new Map<string, string>();
    for (const session of this.sessions.values()) {
      if (session.container_id) {
        result.set(session.container_id, session.session_id);
      }
    }
    return result;
  }

  get activeCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "active" || s.status === "idle") count++;
    }
    return count;
  }

  get pausedCount(): number {
    return this.listByStatus("paused").length;
  }

  /**
   * Reload active/paused sessions from DB on server startup.
   * Verifies each container still exists; marks orphans as closed.
   */
  async loadFromDB(containerManager: ContainerManager): Promise<void> {
    this.containerManager = containerManager;
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(
        inArray(schema.workspaces.status, ["active", "paused", "idle", "resumable"]),
      );

    let loaded = 0;
    let orphaned = 0;

    for (const row of rows) {
      if (!row.container_id) {
        await this.markResumableInDB(row);
        orphaned++;
        continue;
      }

      let containerStatus: "running" | "paused" | "exited" | "not_found";
      try {
        containerStatus = await containerManager.getContainerStatus(row.container_id);
      } catch (err) {
        this.log.error({ sessionId: row.session_id, containerId: row.container_id, err }, "Failed to check container status on reload");
        await this.markResumableInDB(row);
        orphaned++;
        continue;
      }

      if (containerStatus === "not_found" || containerStatus === "exited") {
        await this.markResumableInDB(row);
        orphaned++;
        continue;
      }

      // Container exists (running or paused) — add to in-memory Map
      const session: Workspace = {
        session_id: row.session_id,
        container_id: row.container_id,
        user_id: row.user_id ?? "",
        org_id: row.org_id ?? null,
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
      this.sessions.set(row.session_id, session);
      loaded++;
    }

    this.log.info({ loaded, resumable: orphaned }, "Sessions reloaded from DB");
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const entries = Array.from(this.sessions.entries());
    const connectedIds = this.getConnectedSessionIds();

    for (const [id, session] of entries) {
      // Check absolute expiry
      if (new Date(session.expires_at).getTime() <= now) {
        // Destroy container if it exists (covers paused sessions too)
        if (session.container_id) {
          try {
            await this.callbacks.onIdleExpiry(id, session.container_id);
          } catch { /* container may be gone */ }
        }
        session.status = "expired";
        this.sessions.delete(id);
        await this.markExpiredInDB(id, true, session.volume_id ?? undefined);
        await this.callbacks.onExpired(id);
        continue;
      }

      // Sessions with a live WebSocket connection are never idle
      if (connectedIds.has(id)) {
        if (session.status === "idle") {
          session.status = "active";
        }
        continue;
      }

      const idleMs = now - new Date(session.last_active_at).getTime();

      // Check idle TTL — mark as idle first
      if (session.status === "active" && idleMs > this.config.idleTtlSecs * 1000) {
        session.status = "idle";
      }

      // Persistent sessions: pause instead of destroy
      if (
        session.status === "idle" &&
        session.persistent &&
        session.container_id &&
        idleMs > this.config.workstationIdlePauseSecs * 1000
      ) {
        await this.pauseSession(id, session);
        continue;
      }

      // Non-persistent sessions: destroy on idle
      if (
        session.status === "idle" &&
        !session.persistent &&
        session.container_id &&
        idleMs > this.config.idleTtlSecs * 1000
      ) {
        await this.callbacks.onIdleExpiry(id, session.container_id);
        session.status = "resumable";
        session.container_id = null;
        await this.db
          .update(schema.workspaces)
          .set({ status: "resumable" as WorkspaceStatus, container_id: null })
          .where(eq(schema.workspaces.session_id, id));
      }
    }

    // Reap volumes whose TTL has expired
    await this.reapExpiredVolumes();
  }

  private async pauseSession(sessionId: string, session: Workspace): Promise<void> {
    // Evict oldest paused session if at capacity
    await this.evictIfNeeded();

    // Call pause callback first — only update status on success
    try {
      await this.callbacks.onIdlePause(sessionId, session.container_id!);
    } catch (err) {
      this.log.error({ sessionId, containerId: session.container_id, err }, "Failed to pause container, skipping");
      return;
    }

    session.status = "paused";
    await this.db
      .update(schema.workspaces)
      .set({ status: "paused" as WorkspaceStatus })
      .where(eq(schema.workspaces.session_id, sessionId));

    this.log.info({ sessionId, containerId: session.container_id }, "Session paused");
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.pausedCount < this.config.maxPaused) return;

    // Find oldest paused by last_active_at (single pass)
    let victim: Workspace | null = null;
    let oldestTime = Infinity;
    for (const s of this.sessions.values()) {
      if (s.status === "paused") {
        const t = new Date(s.last_active_at).getTime();
        if (t < oldestTime) {
          oldestTime = t;
          victim = s;
        }
      }
    }
    if (!victim) return;

    this.log.info(
      { sessionId: victim.session_id, containerId: victim.container_id },
      "Evicting oldest paused session to make room",
    );

    if (victim.container_id) {
      try {
        await this.callbacks.onIdleExpiry(victim.session_id, victim.container_id);
      } catch { /* container may be gone */ }
    }
    this.sessions.delete(victim.session_id);
    await this.markExpiredInDB(victim.session_id, true, victim.volume_id ?? undefined);
  }

  /**
   * Mark a session as resumable and add it to the in-memory Map so it
   * shows up in listings. Called during loadFromDB for orphaned sessions.
   */
  private async markResumableInDB(row: Record<string, unknown>): Promise<void> {
    const sessionId = row.session_id as string;
    await this.db
      .update(schema.workspaces)
      .set({ status: "resumable" as WorkspaceStatus, container_id: null })
      .where(eq(schema.workspaces.session_id, sessionId));

    const session: Workspace = {
      session_id: sessionId,
      container_id: null,
      user_id: (row.user_id as string) ?? "",
      org_id: (row.org_id as string | null | undefined) ?? null,
      profile_id: row.profile_id as string,
      name: (row.name as string) ?? null,
      pinned: row.pinned as boolean,
      starred: row.starred as boolean,
      tags: row.tags as string[],
      archived: row.archived as boolean,
      last_opened_at: (row.last_opened_at as string) ?? null,
      persistent: row.persistent as boolean,
      volume_id: (row.volume_id as string) ?? null,
      volume_expires_at: (row.volume_expires_at as string) ?? null,
      public_preview: (row.public_preview as boolean) ?? false,
      model_override: (row.model_override as string | null) ?? null,
      last_run_model: (row.last_run_model as string | null) ?? null,
      status: "resumable",
      last_active_at: row.last_active_at as string,
      created_at: row.created_at as string,
      expires_at: row.expires_at as string,
    };
    this.sessions.set(sessionId, session);
  }

  private async markExpiredInDB(sessionId: string, clearContainer = false, volumeId?: string): Promise<void> {
    const updates: Record<string, unknown> = { status: "expired" as WorkspaceStatus };
    if (clearContainer) {
      updates.container_id = null;
    }
    if (volumeId) {
      const ttlMs = this.config.volumeTtlDays * 24 * 60 * 60 * 1000;
      updates.volume_expires_at = new Date(Date.now() + ttlMs).toISOString();
    }

    await this.db
      .update(schema.workspaces)
      .set(updates)
      .where(eq(schema.workspaces.session_id, sessionId));
  }

  /** Reap volumes whose TTL has expired. Called periodically by sweep(). */
  private async reapExpiredVolumes(): Promise<void> {
    if (!this.containerManager) return;

    const now = new Date().toISOString();
    const rows = await this.db
      .select({
        session_id: schema.workspaces.session_id,
        volume_id: schema.workspaces.volume_id,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.status, "expired"),
          isNotNull(schema.workspaces.volume_id),
          isNotNull(schema.workspaces.volume_expires_at),
          lte(schema.workspaces.volume_expires_at, now),
        ),
      );

    for (const row of rows) {
      const volumeId = row.volume_id!;
      this.log.info({ sessionId: row.session_id, volumeId }, "Reaping expired volumes");

      // Remove each volume independently to handle partial failures.
      for (const prefix of [VOLUME_PREFIX_WORKSPACE, VOLUME_PREFIX_SDK]) {
        try {
          await this.containerManager.removeNamedVolume(`${prefix}${volumeId}`);
        } catch (err) {
          this.log.warn({ sessionId: row.session_id, volume: `${prefix}${volumeId}`, err }, "Failed to remove volume (may already be gone)");
        }
      }

      // Clear volume references regardless of removal success to prevent infinite retries
      await this.db
        .update(schema.workspaces)
        .set({ volume_id: null, volume_expires_at: null })
        .where(eq(schema.workspaces.session_id, row.session_id));
    }
  }
}

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
  /** Pause a NON-persistent session's container after this idle window (0 =
   *  disabled). Distinct from workstationIdlePauseSecs, which governs
   *  persistent sessions. Issue #333. */
  sessionIdlePauseSecs: number;
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
/** Feature 0001: per-workspace `/var/lib/docker` for docker_access sessions, so a
 *  pinned workspace keeps its nested image/build cache across container restarts. */
export const VOLUME_PREFIX_DOCKER = "vonzio-dind-";

export class SessionRegistry {
  private sessions = new Map<string, Workspace>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private containerManager: ContainerManager | null = null;
  /** Callback to get session IDs with live WS connections. Injected by server. */
  getConnectedSessionIds: () => Set<string> = () => new Set();
  /** Whether a session may be idle-paused. Injected by server to exempt
   *  playbook sessions (pb-*) and sessions with a task currently dispatching —
   *  a playbook sitting in a chain_delay_ms gap has no WS connection and no
   *  active task, so wall-clock idleness alone would freeze it mid-run. */
  isSessionPausable: (sessionId: string) => boolean = () => true;
  /** When each paused container was paused — for logging the CPU-idle time
   *  actually saved (issue #333 metrics). In-memory only. */
  private pausedAtMs = new Map<string, number>();
  /** Ephemeral, connection-scoped local-exec state (CLI `--local-exec`). NOT
   *  persisted — it's a property of the live WS connection, not the workspace
   *  row. Set on session.start when the client advertised the capability;
   *  cleared on session end. `root` is the CLI's cwd label (display only). */
  private localExec = new Map<string, { root: string }>();

  setLocalExec(sessionId: string, info: { root: string } | null): void {
    if (info) this.localExec.set(sessionId, info);
    else this.localExec.delete(sessionId);
  }

  getLocalExec(sessionId: string): { root: string } | null {
    return this.localExec.get(sessionId) ?? null;
  }

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
      public_ports: [],
      preview_codes: {},
      model_override: null,
      api_key_id_override: null,
      last_run_model: null,
      status: "active",
      last_active_at: now,
      created_at: now,
      expires_at: expiresAt,
    };

    this.sessions.set(sessionId, session);

    // Revive-or-insert. A workspace row may already exist for this
    // session id with status "expired" — expired rows are retained for
    // history, and chat surfaces (Telegram active-session mappings,
    // playbook threads) can legitimately re-dispatch under the same id
    // long after expiry. A blind insert then dies on workspaces_pkey
    // (surfaced 2026-07-05: agent-bound Telegram bot replying into a
    // chat mapped to an expired pb-* session). Reviving preserves the
    // row's identity fields (name, tags, created_at) and refreshes the
    // lifecycle columns. Guard: never revive a row owned by a DIFFERENT
    // user — a session id is not a capability.
    const revived = await this.db
      .update(schema.workspaces)
      .set({
        container_id: containerId,
        profile_id: profileId,
        persistent,
        status: "active",
        last_active_at: now,
        expires_at: expiresAt,
      })
      .where(
        and(
          eq(schema.workspaces.session_id, sessionId),
          eq(schema.workspaces.user_id, userId),
        ),
      )
      .returning({ session_id: schema.workspaces.session_id });
    if (revived.length === 0) {
      try {
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
      } catch (err) {
        this.sessions.delete(sessionId);
        // Only a UNIQUE-violation on the primary key means the session id
        // is taken by another user (the update above already excluded
        // same-user rows). Any OTHER insert failure (e.g. the SaaS
        // org_id NOT NULL check when a caller forgot to pin the org) must
        // surface as-is — wrapping it in "already exists / not owned by
        // user" masked exactly that class (Slack inbound, 2026-07-06).
        const code = (err as { code?: string })?.code;
        if (code === "23505") {
          throw new Error(
            `session ${sessionId} already exists and is not owned by user ${userId}`,
            { cause: err },
          );
        }
        throw err;
      }
    }

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
      if (session.status === "paused") this.logPausedSavings(sessionId, "resumed");
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
      public_ports: row.public_ports ?? [],
      preview_codes: row.preview_codes ?? {},
      model_override: row.model_override ?? null,
      api_key_id_override: row.api_key_id_override ?? null,
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
        public_ports: row.public_ports ?? [],
        preview_codes: row.preview_codes ?? {},
        model_override: row.model_override ?? null,
        api_key_id_override: row.api_key_id_override ?? null,
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
    this.localExec.delete(sessionId);
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

  /**
   * All container IDs recorded in the DB workspaces table — the AUTHORITATIVE
   * set the orphan sweep must never reap. The in-memory Map alone misses
   * containers in a brief window (freshly created + persisted, but not yet
   * registered in memory; or a continuation that reassigned the container),
   * which let the 5-minute sweep delete live workspace containers mid-run.
   */
  async dbContainerIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ container_id: schema.workspaces.container_id })
      .from(schema.workspaces)
      .where(isNotNull(schema.workspaces.container_id));
    const set = new Set<string>();
    for (const r of rows) if (r.container_id) set.add(r.container_id);
    return set;
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
        public_ports: row.public_ports ?? [],
        preview_codes: row.preview_codes ?? {},
        model_override: row.model_override ?? null,
        api_key_id_override: row.api_key_id_override ?? null,
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
      // Pinned ("always-on") sessions are fully exempt from the sweeper: no
      // idle-pause, no idle-destroy, and no absolute expiry. Keep their TTL
      // pushed forward so the displayed expiry reflects "alive" and the expiry
      // path below can never trip. They stay until the user unpins or deletes.
      if (session.pinned) {
        // Only un-idle a session that actually has a live container — don't
        // paint a paused/reaped (container-less) session as a fake "active"
        // zombie. It still isn't destroyed/expired; it just keeps its status.
        if (session.status === "idle" && session.container_id) session.status = "active";
        const horizon = now + this.config.maxLifetimeSecs * 1000;
        // Only write when the stored expiry has drifted past the halfway mark
        // to avoid a DB write on every 30s tick.
        if (new Date(session.expires_at).getTime() - now < (this.config.maxLifetimeSecs * 1000) / 2) {
          const next = new Date(horizon).toISOString();
          session.expires_at = next;
          await this.db
            .update(schema.workspaces)
            .set({ expires_at: next })
            .where(eq(schema.workspaces.session_id, id));
        }
        continue;
      }

      // Check absolute expiry
      if (new Date(session.expires_at).getTime() <= now) {
        this.logPausedSavings(id, "absolute expiry");
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

      // Non-persistent sessions: pause early (issue #333). A parked chat
      // otherwise burns CPU/scheduler for the whole idle TTL window before
      // teardown; docker pause freezes it at ~zero CPU while keeping resume
      // instant (unpause — no rebuild, no context replay). Full teardown
      // still happens at idleTtlSecs below.
      if (
        session.status === "active" &&
        !session.persistent &&
        session.container_id &&
        this.config.sessionIdlePauseSecs > 0 &&
        idleMs > this.config.sessionIdlePauseSecs * 1000 &&
        idleMs <= this.config.idleTtlSecs * 1000 &&
        this.isSessionPausable(id)
      ) {
        await this.pauseSession(id, session);
        continue;
      }

      // Non-persistent sessions: destroy on idle. "paused" is included so a
      // container paused by the branch above still gets torn down at the TTL
      // (rm -f works on paused containers — no unpause needed). The pausable
      // predicate gates teardown too: a playbook in a >TTL chain_delay_ms gap
      // must not lose its container (and workspace files) mid-run — it was
      // exempt from this teardown by nothing before #333 either, which could
      // wipe a long-gapped chain's workspace; absolute expiry still bounds it.
      if (
        (session.status === "idle" || session.status === "paused") &&
        !session.persistent &&
        session.container_id &&
        idleMs > this.config.idleTtlSecs * 1000 &&
        this.isSessionPausable(id)
      ) {
        this.logPausedSavings(id, "idle-ttl teardown");
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
    // Evict oldest paused workstation if at capacity. Only persistent sessions
    // count against (or fall victim to) the workstation pause budget —
    // non-persistent paused chats are bounded by their own idle TTL teardown.
    if (session.persistent) await this.evictIfNeeded();

    // Call pause callback first — only update status on success
    try {
      await this.callbacks.onIdlePause(sessionId, session.container_id!);
    } catch (err) {
      this.log.error({ sessionId, containerId: session.container_id, err }, "Failed to pause container, skipping");
      return;
    }

    session.status = "paused";
    this.pausedAtMs.set(sessionId, Date.now());
    await this.db
      .update(schema.workspaces)
      .set({ status: "paused" as WorkspaceStatus })
      .where(eq(schema.workspaces.session_id, sessionId));

    this.log.info(
      { sessionId, containerId: session.container_id, persistent: session.persistent },
      "Session paused",
    );
  }

  /** Log how long a container sat paused (CPU-idle time saved, issue #333)
   *  and drop the bookkeeping entry. No-op if the session was never paused. */
  private logPausedSavings(sessionId: string, reason: string): void {
    const pausedAt = this.pausedAtMs.get(sessionId);
    if (pausedAt === undefined) return;
    this.pausedAtMs.delete(sessionId);
    this.log.info(
      { sessionId, pausedSecs: Math.round((Date.now() - pausedAt) / 1000), reason },
      "Paused-container savings",
    );
  }

  private async evictIfNeeded(): Promise<void> {
    let pausedPersistent = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "paused" && s.persistent) pausedPersistent++;
    }
    if (pausedPersistent < this.config.maxPaused) return;

    // Find oldest paused workstation by last_active_at (single pass)
    let victim: Workspace | null = null;
    let oldestTime = Infinity;
    for (const s of this.sessions.values()) {
      if (s.status === "paused" && s.persistent) {
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

    this.logPausedSavings(victim.session_id, "paused-capacity eviction");
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
      public_ports: (row.public_ports as string[] | null) ?? [],
      preview_codes: (row.preview_codes as Record<string, { code_enc: string; code_version: number }> | null) ?? {},
      model_override: (row.model_override as string | null) ?? null,
      api_key_id_override: (row.api_key_id_override as string | null) ?? null,
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
      for (const prefix of [VOLUME_PREFIX_WORKSPACE, VOLUME_PREFIX_SDK, VOLUME_PREFIX_DOCKER]) {
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

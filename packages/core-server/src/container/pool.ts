import type { ContainerManager } from "@vonzio/shared";
import type { SessionRegistry } from "./session-registry.js";
import { CONTAINER_MODE_LABEL, ContainerMode } from "./docker-manager.js";

interface PoolEntry {
  containerId: string;
  status: "idle" | "busy";
  recycleCount: number;
  lastUsed: Date;
}

export class ContainerPool {
  private containers = new Map<string, PoolEntry>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private drainInterval: ReturnType<typeof setInterval> | null = null;
  private orphanSweepInterval: ReturnType<typeof setInterval> | null = null;
  private sessionRegistry: SessionRegistry | null = null;
  private onOrphanRemoved: ((containerId: string) => void) | null = null;
  // Two-strikes orphan detection: a container is only reaped if it looked
  // orphaned on the PREVIOUS sweep too. This defeats the transient
  // reassign/resurrection race that made the old always-on sweep delete live
  // session containers mid-run — a brief window (seconds) never survives two
  // sweeps spaced minutes apart.
  private orphanCandidates = new Set<string>();
  // Minimum container age before it's eligible for reaping. Belt-and-suspenders
  // on top of two-strikes: a freshly created container whose DB row hasn't been
  // written yet is never in scope.
  private static readonly ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  // Guard against overlapping sweeps if a single sweep's Docker/DB reads run
  // longer than the interval — setInterval would otherwise stack invocations.
  private sweeping = false;

  constructor(
    private manager: ContainerManager,
    private config: {
      minSize: number;
      maxSize: number;
      idleDrainSecs: number;
      maxRecycles: number;
      healthCheckIntervalSecs: number;
      cleanupCmd: string[];
    },
    private createContainerOpts: () => Parameters<ContainerManager["createContainer"]>[0],
  ) {}

  /**
   * Set the session registry so orphan sweeps can avoid killing session containers.
   * Must be called before init().
   */
  setSessionRegistry(registry: SessionRegistry, onOrphanRemoved?: (id: string) => void): void {
    this.sessionRegistry = registry;
    this.onOrphanRemoved = onOrphanRemoved ?? null;
  }

  async init(): Promise<void> {
    // Seed the orphan-candidate set (strike 1) without reaping. The first
    // periodic sweep that follows confirms (strike 2) and reaps. This keeps
    // even a cold-start free of the reassign race.
    await this.sweepOrphans({ reap: false });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minSize; i++) {
      promises.push(this.addContainer());
    }
    await Promise.all(promises);

    this.healthCheckInterval = setInterval(
      () => this.healthCheck(),
      this.config.healthCheckIntervalSecs * 1000,
    );

    this.drainInterval = setInterval(
      () => this.drainExcess(),
      this.config.idleDrainSecs * 1000,
    );

    // Periodic orphan sweep. An earlier version was removed because it
    // force-removed (rm -f) LIVE session containers whenever their session ↔
    // container_id link was briefly absent (resumable/expired/evicted/reassign
    // race). This version is safe to run continuously: it reaps a container
    // only when ALL of these hold — (a) it is not tracked by the pool, the
    // in-memory session map, OR the DB workspaces table (DB read fails closed,
    // skipping the whole sweep); (b) it is not a VPN sidecar or the egress
    // proxy; (c) it is older than ORPHAN_MIN_AGE_MS; and (d) it looked orphaned
    // on the previous sweep too (two-strikes). Without this, dead session
    // containers (crash/restart/reassign-dup) accumulate forever, since
    // onIdleExpiry only fires for sessions that expire while still in memory.
    this.orphanSweepInterval = setInterval(
      () => this.sweepOrphans({ reap: true }),
      ContainerPool.ORPHAN_SWEEP_INTERVAL_MS,
    );
  }

  async claim(): Promise<string> {
    for (const [id, entry] of this.containers) {
      if (entry.status === "idle") {
        entry.status = "busy";
        entry.lastUsed = new Date();
        return id;
      }
    }

    if (this.containers.size < this.config.maxSize) {
      const id = await this.createOne();
      const entry = this.containers.get(id)!;
      entry.status = "busy";
      entry.lastUsed = new Date();
      return id;
    }

    throw new Error("Pool exhausted: no idle containers and at max capacity");
  }

  async release(containerId: string): Promise<void> {
    const entry = this.containers.get(containerId);
    if (!entry) return;

    entry.recycleCount++;

    if (entry.recycleCount >= this.config.maxRecycles) {
      await this.destroyContainer(containerId);
      await this.addContainer();
      return;
    }

    try {
      for await (const _ of this.manager.execInContainer(containerId, this.config.cleanupCmd)) {
        // drain
      }
    } catch {
      await this.destroyContainer(containerId);
      await this.addContainer();
      return;
    }

    entry.status = "idle";
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.drainInterval) clearInterval(this.drainInterval);
    if (this.orphanSweepInterval) clearInterval(this.orphanSweepInterval);

    const promises = Array.from(this.containers.keys()).map((id) =>
      this.destroyContainer(id),
    );
    await Promise.all(promises);
  }

  get idleCount(): number {
    let count = 0;
    for (const entry of this.containers.values()) {
      if (entry.status === "idle") count++;
    }
    return count;
  }

  get busyCount(): number {
    let count = 0;
    for (const entry of this.containers.values()) {
      if (entry.status === "busy") count++;
    }
    return count;
  }

  get totalCount(): number {
    return this.containers.size;
  }

  /** Returns a map of container ID → pool status for all tracked containers */
  get trackedContainers(): Map<string, "idle" | "busy"> {
    const result = new Map<string, "idle" | "busy">();
    for (const [id, entry] of this.containers) {
      result.set(id, entry.status);
    }
    return result;
  }

  private async addContainer(): Promise<void> {
    const id = await this.createOne();
    this.containers.get(id)!.status = "idle";
  }

  private async createOne(): Promise<string> {
    const opts = this.createContainerOpts();
    const id = await this.manager.createContainer(opts);
    await this.manager.startContainer(id);
    this.containers.set(id, {
      containerId: id,
      status: "idle",
      recycleCount: 0,
      lastUsed: new Date(),
    });
    return id;
  }

  private async destroyContainer(id: string): Promise<void> {
    this.containers.delete(id);
    try {
      await this.manager.removeContainer(id, true);
    } catch {
      // Container may already be gone
    }
  }

  private async healthCheck(): Promise<void> {
    const idleContainers = Array.from(this.containers.entries()).filter(
      ([, e]) => e.status === "idle",
    );

    for (const [id] of idleContainers) {
      const status = await this.manager.getContainerStatus(id);
      if (status !== "running") {
        await this.destroyContainer(id);
        // Replace to maintain pool depth
        if (this.containers.size < this.config.minSize) {
          await this.addContainer();
        }
      }
    }
  }

  private async drainExcess(): Promise<void> {
    const now = Date.now();
    const drainThreshold = this.config.idleDrainSecs * 1000;

    const idleEntries = Array.from(this.containers.entries()).filter(
      ([, e]) => e.status === "idle",
    );

    // Only drain if above min size
    for (const [id, entry] of idleEntries) {
      if (this.containers.size <= this.config.minSize) break;
      if (now - entry.lastUsed.getTime() > drainThreshold) {
        await this.destroyContainer(id);
      }
    }
  }

  /**
   * The set of managed containers that currently look orphaned — in Docker with
   * the managed-by=vonzio label but not tracked by the pool, the in-memory
   * session map, or the DB workspaces table, not a VPN sidecar / egress proxy,
   * and older than ORPHAN_MIN_AGE_MS. Returns null if the DB read fails (fail
   * closed — the caller must not reap anything).
   */
  private async findOrphans(): Promise<Set<string> | null> {
    // Fail closed without a registry: its in-memory map AND the DB workspaces
    // table are the only things that mark a container as live-owned. With no
    // registry both keep-sets would be empty and every managed container would
    // look orphaned — exactly the over-reaping we must never do.
    if (!this.sessionRegistry) return null;

    const allContainers = await this.manager.listManagedContainers();
    const sessionContainerIds = new Set(this.sessionRegistry.containerSessionMap.keys());
    // DB is authoritative: a container owned by ANY workspace row must never be
    // reaped, even if it's momentarily absent from the in-memory Map
    // (creation/reassignment window). Fail closed if the DB read errors, so a
    // transient hiccup can't cause mass deletion.
    let dbContainerIds: Set<string>;
    try {
      dbContainerIds = await this.sessionRegistry.dbContainerIds();
    } catch {
      return null;
    }

    const now = Date.now();
    const orphans = new Set<string>();
    for (const container of allContainers) {
      if (this.containers.has(container.id)) continue;
      if (sessionContainerIds.has(container.id) || dbContainerIds.has(container.id)) continue;
      // VPN sidecars are owned by the orchestrator (ensureVpnSidecar) and
      // paired-removed in safeRemoveContainer. The egress proxy is long-lived
      // shared infra (a compose service). Both carry managed-by=vonzio so they
      // look like orphans here — never reap them.
      const mode = container.labels?.[CONTAINER_MODE_LABEL];
      if (mode === ContainerMode.VpnSidecar || mode === ContainerMode.EgressProxy) continue;
      // Age guard: a just-created container whose DB row isn't written yet is
      // never in scope. An unparseable created_at (NaN) is NOT treated as young
      // — otherwise such an orphan could never be reaped by sweep OR prune; we
      // let it through and rely on the DB keep-set + two-strikes to protect any
      // live container.
      const ageMs = now - new Date(container.created_at).getTime();
      if (Number.isFinite(ageMs) && ageMs <= ContainerPool.ORPHAN_MIN_AGE_MS) continue;
      orphans.add(container.id);
    }
    return orphans;
  }

  /**
   * Reap orphaned managed containers. With `reap: false`, only records the
   * current orphan candidates (strike 1) without removing anything. With
   * `reap: true`, removes containers that were also candidates on the previous
   * sweep (two-strikes) and refreshes the candidate set.
   */
  private async sweepOrphans({ reap }: { reap: boolean }): Promise<void> {
    if (this.sweeping) return; // a prior sweep is still running — don't overlap
    this.sweeping = true;
    try {
      const orphans = await this.findOrphans();
      if (!orphans) return; // DB read failed — fail closed
      if (reap) {
        for (const id of orphans) {
          if (!this.orphanCandidates.has(id)) continue; // needs a second strike
          try {
            await this.manager.removeContainer(id, true);
            this.onOrphanRemoved?.(id);
          } catch {
            // Container may already be gone
          }
        }
      }
      this.orphanCandidates = orphans;
    } catch {
      // Don't crash if Docker is temporarily unreachable
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Force-remove every currently-orphaned managed container in one pass
   * (no two-strikes wait) — backs the admin "Prune orphans" action. Uses the
   * same DB-authoritative + age + sidecar/egress safety checks as the periodic
   * sweep. Returns the IDs removed. Throws if the DB read fails closed.
   */
  async pruneOrphans(): Promise<string[]> {
    const orphans = await this.findOrphans();
    if (!orphans) throw new Error("Could not determine orphans (database unavailable)");
    const removed: string[] = [];
    for (const id of orphans) {
      try {
        await this.manager.removeContainer(id, true);
        this.onOrphanRemoved?.(id);
        this.orphanCandidates.delete(id);
        removed.push(id);
      } catch {
        // Container may already be gone
      }
    }
    return removed;
  }
}

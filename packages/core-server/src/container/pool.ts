import type { ContainerManager } from "@vonzio/shared";
import type { SessionRegistry } from "./session-registry.js";

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
    // Clean orphans from previous server runs before creating new pool containers
    await this.sweepOrphans();

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

    // NOTE: no periodic orphan sweep. It existed to clean leftover *pool*
    // containers, but pooled/batch modes are effectively unused (POOL_MIN_SIZE=0,
    // product is session-only) so it had no legitimate work — meanwhile it
    // force-removed (rm -f) LIVE session containers whenever their session ↔
    // container_id link was briefly absent (resumable/expired/evicted/reassign
    // race), causing mid-run "container not running" failures. Cross-restart
    // leftovers are handled by the one-shot DB-guarded sweepOrphans() in init()
    // above; the running session lifecycle (pause/resume/expire) owns session
    // containers from then on.
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
   * Find and remove orphaned containers — those in Docker with the managed-by=vonzio
   * label but not tracked by this pool or any active session.
   */
  private async sweepOrphans(): Promise<void> {
    try {
      const allContainers = await this.manager.listManagedContainers();
      const sessionContainerIds = this.sessionRegistry
        ? new Set(this.sessionRegistry.containerSessionMap.keys())
        : new Set<string>();
      // DB is authoritative: a container owned by ANY workspace row must never
      // be reaped, even if it's momentarily absent from the in-memory Map
      // (creation/reassignment window). Without this, the 5-min sweep deleted
      // live workspace containers mid-run. Fail closed (skip the whole sweep)
      // if the DB read errors, so a transient hiccup can't cause mass deletion.
      let dbContainerIds: Set<string>;
      try {
        dbContainerIds = this.sessionRegistry
          ? await this.sessionRegistry.dbContainerIds()
          : new Set<string>();
      } catch {
        return;
      }

      for (const container of allContainers) {
        const inPool = this.containers.has(container.id);
        const inSession = sessionContainerIds.has(container.id) || dbContainerIds.has(container.id);
        // VPN sidecars are owned by the orchestrator's ensureVpnSidecar
        // and paired-removed alongside their agent in safeRemoveContainer.
        // The pool doesn't track them, so they look like orphans here.
        // Skip them — the orchestrator's lifecycle is authoritative.
        const isVpnSidecar = container.labels?.["vonzio-mode"] === "vpn-sidecar";
        // Session containers are owned by the SessionRegistry lifecycle
        // (pause/resume/expire/evict) — never let the pool reap them, even on
        // the startup sweep. Belt-and-suspenders on top of the pool/session/DB
        // checks: the registry is authoritative for these.
        const isSession = container.labels?.["vonzio-mode"] === "session";

        if (!inPool && !inSession && !isVpnSidecar && !isSession) {
          try {
            await this.manager.removeContainer(container.id, true);
            this.onOrphanRemoved?.(container.id);
          } catch {
            // Container may already be gone
          }
        }
      }
    } catch {
      // Don't crash if Docker is temporarily unreachable
    }
  }
}

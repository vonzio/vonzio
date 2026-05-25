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

    // Sweep orphans every 5 minutes
    this.orphanSweepInterval = setInterval(
      () => this.sweepOrphans(),
      5 * 60 * 1000,
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
   * Find and remove orphaned containers — those in Docker with the managed-by=vonzio
   * label but not tracked by this pool or any active session.
   */
  private async sweepOrphans(): Promise<void> {
    try {
      const allContainers = await this.manager.listManagedContainers();
      const sessionContainerIds = this.sessionRegistry
        ? new Set(this.sessionRegistry.containerSessionMap.keys())
        : new Set<string>();

      for (const container of allContainers) {
        const inPool = this.containers.has(container.id);
        const inSession = sessionContainerIds.has(container.id);

        if (!inPool && !inSession) {
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

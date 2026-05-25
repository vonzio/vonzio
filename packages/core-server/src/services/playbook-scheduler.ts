import { CronExpressionParser } from "cron-parser";
import type { PlaybookService } from "./playbook-service.js";
import type { ChainRunner } from "../orchestrator/chain-runner.js";
import type { Logger } from "../orchestrator/orchestrator.js";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export class PlaybookScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private log: Logger;
  private runningPlaybooks = new Set<string>();
  private paused = false;

  constructor(
    private playbookService: PlaybookService,
    private chainRunner: ChainRunner,
    private log_?: Logger,
  ) {
    this.log = log_?.child({ component: "playbook-scheduler" }) ?? noopLogger;
  }

  start(): void {
    if (this.interval) return;
    this.log.info({}, "Playbook scheduler started (60s tick)");

    // Initial computation of next_run_at for all enabled playbooks
    this.computeAllNextRuns().catch((err) =>
      this.log.error({ error: String(err) }, "Failed to compute initial next_run_at"),
    );

    this.interval = setInterval(() => {
      this.tick().catch((err) =>
        this.log.error({ error: String(err) }, "Scheduler tick error"),
      );
    }, 60_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.log.info({}, "Playbook scheduler stopped");
    }
  }

  pause(): void {
    this.paused = true;
    this.log.info({}, "Scheduler paused");
  }

  resume(): void {
    this.paused = false;
    this.log.info({}, "Scheduler resumed");
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Recompute next_run_at for a specific playbook (call after CRUD) */
  async recomputeNextRun(playbookId: string): Promise<void> {
    const playbook = await this.playbookService.get(playbookId);
    if (!playbook || !playbook.enabled) {
      await this.playbookService.setNextRunAt(playbookId, null);
      return;
    }

    switch (playbook.trigger_type) {
      case "cron":
        const nextCron = this.computeNextCronRun(playbook.schedule);
        await this.playbookService.setNextRunAt(playbookId, nextCron);
        break;
      case "interval": {
        const base = playbook.last_run_at ? new Date(playbook.last_run_at) : new Date();
        const next = new Date(base.getTime() + (playbook.interval_seconds ?? 3600) * 1000);
        await this.playbookService.setNextRunAt(playbookId, next.toISOString());
        break;
      }
      case "manual":
      case "webhook":
        await this.playbookService.setNextRunAt(playbookId, null);
        break;
    }
  }

  private async computeAllNextRuns(): Promise<void> {
    const playbooks = await this.playbookService.listAllEnabled();
    for (const pb of playbooks) {
      if (!pb.next_run_at) {
        await this.recomputeNextRun(pb.id);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.paused) return;
    const now = new Date();
    const playbooks = await this.playbookService.listAllEnabled();

    for (const pb of playbooks) {
      // Skip if already running
      if (this.runningPlaybooks.has(pb.id)) continue;

      // Check if it's time to run
      if (!pb.next_run_at) {
        const nextRun = this.computeNextCronRun(pb.schedule);
        if (nextRun) await this.playbookService.setNextRunAt(pb.id, nextRun);
        continue;
      }

      const nextRunTime = new Date(pb.next_run_at);
      if (nextRunTime > now) continue;

      // Fire!
      this.log.info({ playbookId: pb.id, name: pb.name, schedule: pb.schedule }, "Firing playbook");
      this.runningPlaybooks.add(pb.id);

      // Compute next run time before starting (so we don't double-fire)
      if (pb.trigger_type === "cron") {
        const nextRun = this.computeNextCronRun(pb.schedule);
        await this.playbookService.setNextRunAt(pb.id, nextRun);
      } else if (pb.trigger_type === "interval") {
        const next = new Date(Date.now() + (pb.interval_seconds ?? 3600) * 1000);
        await this.playbookService.setNextRunAt(pb.id, next.toISOString());
      }
      // manual and webhook don't auto-schedule

      // Execute in background
      this.chainRunner.execute(pb, pb.user_id).then(
        (run) => {
          this.runningPlaybooks.delete(pb.id);
          this.log.info(
            { playbookId: pb.id, runId: run.id, status: run.status, chains: run.chain_count },
            "Playbook run finished",
          );
        },
        (err) => {
          this.runningPlaybooks.delete(pb.id);
          this.log.error({ playbookId: pb.id, error: String(err) }, "Playbook run error");
        },
      );
    }
  }

  private computeNextCronRun(schedule: string): string | null {
    try {
      const expr = CronExpressionParser.parse(schedule);
      return expr.next().toISOString();
    } catch {
      return null;
    }
  }
}

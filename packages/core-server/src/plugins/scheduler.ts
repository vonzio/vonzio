import type { Scheduler } from "@vonzio/plugin-api";

/**
 * Process-local job scheduler exposed to plugins. v0.1 supports only
 * `interval()` -- cron is deferred until a plugin actually needs
 * non-fixed-rate scheduling (none of the planned extractions do --
 * Telegram's command-resync is a fixed interval).
 *
 * `interval()` semantics: gap BETWEEN successive runs, not from start.
 * If `fn` takes 30s and `ms` is 60s, the next run starts 60s after fn
 * resolves. This avoids backlog accumulation when an integration
 * upstream is slow, which is the right default for self-hosted
 * dashboards where one stuck Slack API call shouldn't queue up retries.
 *
 * `stopAll()` is called from core's shutdown handler -- plugins don't
 * need to track job names themselves. Cancellation is best-effort: if
 * a fn is mid-execution when stopAll() fires, it runs to completion
 * but won't be rescheduled.
 */
export class SchedulerImpl implements Scheduler {
  // We track a sentinel object per job so we can flip `.cancelled` and
  // the in-flight self-rescheduling fn checks it before booking the
  // next timeout. setTimeout handles aren't enough -- they only catch
  // the BETWEEN-runs idle window, not an in-flight fn.
  private jobs = new Map<string, { cancelled: boolean; timeoutId?: NodeJS.Timeout }>();

  cron(_name: string, _schedule: string, _fn: () => Promise<void>): void {
    throw new Error(
      "Scheduler.cron is not implemented in v0.1 -- use interval() for fixed-rate work. " +
        "Cron will land alongside the first plugin that needs it.",
    );
  }

  interval(name: string, ms: number, fn: () => Promise<void>): void {
    if (!name || typeof name !== "string") {
      throw new Error(`scheduler job name must be a non-empty string, got ${JSON.stringify(name)}`);
    }
    if (ms <= 0 || !Number.isFinite(ms)) {
      throw new Error(`scheduler interval ms must be > 0, got ${ms}`);
    }
    if (this.jobs.has(name)) {
      throw new Error(
        `scheduler job "${name}" already registered. Each (plugin, job-name) pair must be unique.`,
      );
    }

    const job: { cancelled: boolean; timeoutId?: NodeJS.Timeout } = { cancelled: false };
    this.jobs.set(name, job);

    const tick = async (): Promise<void> => {
      if (job.cancelled) return;
      try {
        await fn();
      } catch (err) {
        // Don't propagate -- a thrown error inside one job shouldn't
        // kill the scheduler for everyone else. Log structured so
        // ops sees which job failed without grepping a stack.
        console.error(`[scheduler] job "${name}" threw:`, err);
      }
      if (job.cancelled) return;
      job.timeoutId = setTimeout(tick, ms);
    };

    // Defer the first run so init() returns before any plugin work fires.
    job.timeoutId = setTimeout(tick, ms);
  }

  /** Called from core's shutdown handler. Cancels every scheduled job. */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      if (job.timeoutId) clearTimeout(job.timeoutId);
    }
    this.jobs.clear();
  }

  /** For tests + debug endpoints. */
  registeredJobs(): string[] {
    return [...this.jobs.keys()];
  }
}

import type { Task } from "@vonzio/shared";

export class RetryHandler {
  shouldRetry(task: Task, errorType: "timeout" | "error" | "rate_limit"): boolean {
    if (!task.retry) return false;
    if (task.attempt >= task.retry.max_attempts) return false;
    return task.retry.retry_on.includes(errorType);
  }

  nextDelay(task: Task): number {
    if (!task.retry) return 0;
    // Exponential backoff: base * 2^(attempt-1)
    return task.retry.backoff_seconds * 1000 * Math.pow(2, task.attempt - 1);
  }

  prepareRetry(task: Task): Task {
    return {
      ...task,
      status: "queued",
      attempt: task.attempt + 1,
      started_at: undefined,
      finished_at: undefined,
      error: undefined,
      result: undefined,
    };
  }
}

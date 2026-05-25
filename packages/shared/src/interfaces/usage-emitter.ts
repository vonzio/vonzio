export type UsageEvent =
  | {
      kind: "task.started";
      userId: string;
      profileId: string;
      taskId: string;
      timestamp: number;
    }
  | {
      kind: "task.done";
      userId: string;
      profileId: string;
      taskId: string;
      costUsd: number;
      totalTokens: number;
      timestamp: number;
    }
  | {
      kind: "task.failed";
      userId: string;
      profileId: string;
      taskId: string;
      reason: string;
      timestamp: number;
    };

/**
 * Fire-and-forget hook for billing/audit usage events. Default
 * implementation is a no-op (events still go to the local event log).
 * A control-plane implementation pushes to `usage_events` for billing
 * aggregation.
 */
export interface UsageEmitter {
  emit(event: UsageEvent): void;
}

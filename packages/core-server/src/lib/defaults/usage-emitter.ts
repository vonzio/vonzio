import type { UsageEmitter, UsageEvent } from "@vonzio/shared";

/**
 * No-op usage emitter — OSS doesn't aggregate usage for billing.
 * Task lifecycle events still go to the local event log via the
 * orchestrator's EventEmitter. cp-server overrides this to push
 * to a usage_events table for billing aggregation.
 */
export class NoopUsageEmitter implements UsageEmitter {
  emit(_event: UsageEvent): void {
    // intentionally empty
  }
}

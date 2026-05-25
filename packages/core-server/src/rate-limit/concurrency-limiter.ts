import type { ConcurrencyLimiter as IConcurrencyLimiter } from "@vonzio/shared";

export class ConcurrencyLimiter implements IConcurrencyLimiter {
  private activeCounts = new Map<string, number>();
  private limits = new Map<string, number>();

  constructor(private defaultLimit: number) {}

  acquire(key: string): boolean {
    const current = this.activeCounts.get(key) ?? 0;
    const limit = this.limits.get(key) ?? this.defaultLimit;

    if (current >= limit) return false;

    this.activeCounts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.activeCounts.get(key) ?? 0;
    if (current > 0) {
      this.activeCounts.set(key, current - 1);
    }
  }

  active(key: string): number {
    return this.activeCounts.get(key) ?? 0;
  }

  setLimit(key: string, max: number): void {
    this.limits.set(key, max);
  }
}

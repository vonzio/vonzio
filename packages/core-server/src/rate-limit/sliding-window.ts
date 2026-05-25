import type { RateLimiter, RateLimitResult } from "@vonzio/shared";

export class SlidingWindowRateLimiter implements RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private windowMs: number,
    private maxRequests: number,
  ) {}

  tryConsume(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + this.windowMs - now) / 1000);
      return { allowed: false, retryAfter };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}

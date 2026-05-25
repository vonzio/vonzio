export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export interface RateLimiter {
  tryConsume(key: string): RateLimitResult;
  reset(key: string): void;
}

export interface ConcurrencyLimiter {
  acquire(key: string): boolean;
  release(key: string): void;
  active(key: string): number;
  setLimit(key: string, max: number): void;
}

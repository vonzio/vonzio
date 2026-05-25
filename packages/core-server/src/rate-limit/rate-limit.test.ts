import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlidingWindowRateLimiter } from "./sliding-window.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 3);

    expect(limiter.tryConsume("key1").allowed).toBe(true);
    expect(limiter.tryConsume("key1").allowed).toBe(true);
    expect(limiter.tryConsume("key1").allowed).toBe(true);
  });

  it("rejects requests beyond the limit", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 2);

    limiter.tryConsume("key1");
    limiter.tryConsume("key1");
    const result = limiter.tryConsume("key1");

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("allows requests again after window expires", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 1);

    limiter.tryConsume("key1");
    expect(limiter.tryConsume("key1").allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(limiter.tryConsume("key1").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 1);

    limiter.tryConsume("key1");
    expect(limiter.tryConsume("key1").allowed).toBe(false);
    expect(limiter.tryConsume("key2").allowed).toBe(true);
  });

  it("reset clears a key", () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 1);

    limiter.tryConsume("key1");
    expect(limiter.tryConsume("key1").allowed).toBe(false);

    limiter.reset("key1");
    expect(limiter.tryConsume("key1").allowed).toBe(true);
  });
});

describe("ConcurrencyLimiter", () => {
  it("allows up to the default limit", () => {
    const limiter = new ConcurrencyLimiter(2);

    expect(limiter.acquire("cred1")).toBe(true);
    expect(limiter.acquire("cred1")).toBe(true);
    expect(limiter.acquire("cred1")).toBe(false);
  });

  it("release allows next acquire", () => {
    const limiter = new ConcurrencyLimiter(1);

    expect(limiter.acquire("cred1")).toBe(true);
    expect(limiter.acquire("cred1")).toBe(false);

    limiter.release("cred1");
    expect(limiter.acquire("cred1")).toBe(true);
  });

  it("tracks active count", () => {
    const limiter = new ConcurrencyLimiter(5);

    expect(limiter.active("cred1")).toBe(0);
    limiter.acquire("cred1");
    limiter.acquire("cred1");
    expect(limiter.active("cred1")).toBe(2);

    limiter.release("cred1");
    expect(limiter.active("cred1")).toBe(1);
  });

  it("supports per-key limit override", () => {
    const limiter = new ConcurrencyLimiter(5);
    limiter.setLimit("cred1", 1);

    expect(limiter.acquire("cred1")).toBe(true);
    expect(limiter.acquire("cred1")).toBe(false);

    // Other keys still use default
    expect(limiter.acquire("cred2")).toBe(true);
    expect(limiter.acquire("cred2")).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new ConcurrencyLimiter(1);

    expect(limiter.acquire("cred1")).toBe(true);
    expect(limiter.acquire("cred1")).toBe(false);
    expect(limiter.acquire("cred2")).toBe(true);
  });

  it("release below zero stays at zero", () => {
    const limiter = new ConcurrencyLimiter(5);
    limiter.release("cred1");
    expect(limiter.active("cred1")).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { RetryHandler } from "./retry.js";
import type { Task } from "@vonzio/shared";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    mode: "batch",
    status: "running",
    prompt: "test",
    profile_id: "prof_1",
    priority: "normal",
    created_at: new Date().toISOString(),
    attempt: 1,
    retry: {
      max_attempts: 3,
      backoff_seconds: 5,
      retry_on: ["timeout", "error", "rate_limit"],
    },
    ...overrides,
  };
}

describe("RetryHandler", () => {
  const handler = new RetryHandler();

  it("allows retry when within max attempts and error type matches", () => {
    const task = makeTask({ attempt: 1 });
    expect(handler.shouldRetry(task, "error")).toBe(true);
    expect(handler.shouldRetry(task, "timeout")).toBe(true);
    expect(handler.shouldRetry(task, "rate_limit")).toBe(true);
  });

  it("rejects retry when at max attempts", () => {
    const task = makeTask({ attempt: 3 });
    expect(handler.shouldRetry(task, "error")).toBe(false);
  });

  it("rejects retry when error type not in retry_on", () => {
    const task = makeTask({
      retry: { max_attempts: 3, backoff_seconds: 5, retry_on: ["timeout"] },
    });
    expect(handler.shouldRetry(task, "error")).toBe(false);
    expect(handler.shouldRetry(task, "timeout")).toBe(true);
  });

  it("rejects retry when no retry policy", () => {
    const task = makeTask({ retry: undefined });
    expect(handler.shouldRetry(task, "error")).toBe(false);
  });

  it("calculates exponential backoff delay", () => {
    const task = makeTask({
      retry: { max_attempts: 5, backoff_seconds: 5, retry_on: ["error"] },
    });

    // attempt 1: 5 * 2^0 = 5s = 5000ms
    expect(handler.nextDelay({ ...task, attempt: 1 })).toBe(5000);
    // attempt 2: 5 * 2^1 = 10s = 10000ms
    expect(handler.nextDelay({ ...task, attempt: 2 })).toBe(10000);
    // attempt 3: 5 * 2^2 = 20s = 20000ms
    expect(handler.nextDelay({ ...task, attempt: 3 })).toBe(20000);
  });

  it("prepareRetry increments attempt and resets status", () => {
    const task = makeTask({
      attempt: 1,
      status: "failed",
      error: "something broke",
      result: { text: "partial", tool_calls: [], session_id: "", input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0 },
    });

    const retried = handler.prepareRetry(task);
    expect(retried.attempt).toBe(2);
    expect(retried.status).toBe("queued");
    expect(retried.error).toBeUndefined();
    expect(retried.result).toBeUndefined();
    expect(retried.started_at).toBeUndefined();
  });
});

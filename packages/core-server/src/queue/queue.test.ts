import { describe, it, expect, vi } from "vitest";
import { InMemoryTaskQueue } from "./in-memory.js";
import type { Task } from "@vonzio/shared";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    mode: "batch",
    status: "queued",
    prompt: "test",
    profile_id: "prof_1",
    priority: "normal",
    created_at: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  };
}

describe("InMemoryTaskQueue", () => {
  it("dequeues in priority order (high > normal > low)", async () => {
    const queue = new InMemoryTaskQueue();
    const low = makeTask({ id: "low", priority: "low" });
    const normal = makeTask({ id: "normal", priority: "normal" });
    const high = makeTask({ id: "high", priority: "high" });

    await queue.enqueue(low);
    await queue.enqueue(normal);
    await queue.enqueue(high);

    expect((await queue.dequeue())!.id).toBe("high");
    expect((await queue.dequeue())!.id).toBe("normal");
    expect((await queue.dequeue())!.id).toBe("low");
  });

  it("maintains FIFO within same priority", async () => {
    const queue = new InMemoryTaskQueue();
    const a = makeTask({ id: "a", priority: "normal" });
    const b = makeTask({ id: "b", priority: "normal" });
    const c = makeTask({ id: "c", priority: "normal" });

    await queue.enqueue(a);
    await queue.enqueue(b);
    await queue.enqueue(c);

    expect((await queue.dequeue())!.id).toBe("a");
    expect((await queue.dequeue())!.id).toBe("b");
    expect((await queue.dequeue())!.id).toBe("c");
  });

  it("returns null when empty", async () => {
    const queue = new InMemoryTaskQueue();
    expect(await queue.dequeue()).toBeNull();
  });

  it("cancels a queued task", async () => {
    const queue = new InMemoryTaskQueue();
    const task = makeTask({ id: "cancel_me" });
    await queue.enqueue(task);

    expect(await queue.depth()).toBe(1);
    expect(await queue.cancel("cancel_me")).toBe(true);
    expect(await queue.depth()).toBe(0);
    expect(await queue.dequeue()).toBeNull();
  });

  it("returns false when cancelling non-existent task", async () => {
    const queue = new InMemoryTaskQueue();
    expect(await queue.cancel("nonexistent")).toBe(false);
  });

  it("fires onReady on each enqueue", async () => {
    const queue = new InMemoryTaskQueue();
    const handler = vi.fn();
    queue.onReady(handler);

    await queue.enqueue(makeTask());
    await queue.enqueue(makeTask());

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("high-priority task inserted after normal tasks dequeues first", async () => {
    const queue = new InMemoryTaskQueue();
    await queue.enqueue(makeTask({ id: "n1", priority: "normal" }));
    await queue.enqueue(makeTask({ id: "n2", priority: "normal" }));
    await queue.enqueue(makeTask({ id: "h1", priority: "high" }));

    expect((await queue.dequeue())!.id).toBe("h1");
    expect((await queue.dequeue())!.id).toBe("n1");
    expect((await queue.dequeue())!.id).toBe("n2");
  });

  it("reports correct depth", async () => {
    const queue = new InMemoryTaskQueue();
    expect(await queue.depth()).toBe(0);

    await queue.enqueue(makeTask());
    await queue.enqueue(makeTask());
    expect(await queue.depth()).toBe(2);

    await queue.dequeue();
    expect(await queue.depth()).toBe(1);
  });
});

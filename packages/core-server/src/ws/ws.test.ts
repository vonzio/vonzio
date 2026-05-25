import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { WebSocket } from "ws";

// Mock WebSocket
function createMockWs(readyState = 1): WebSocket & { sentMessages: string[]; pinged: boolean } {
  const sentMessages: string[] = [];
  return {
    readyState,
    sentMessages,
    pinged: false,
    send(data: string) {
      sentMessages.push(data);
    },
    ping() {
      (this as { pinged: boolean }).pinged = true;
    },
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket & { sentMessages: string[]; pinged: boolean };
}

describe("ConnectionManager", () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  afterEach(() => {
    manager.stop();
  });

  it("adds and removes connections", () => {
    const ws = createMockWs();
    const id = manager.add(ws, "key_1")!;
    expect(id).toBeTruthy();
    expect(manager.count).toBe(1);

    manager.remove(id);
    expect(manager.count).toBe(0);
  });

  it("sends messages to task subscribers", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const id1 = manager.add(ws1, "key_1")!;
    const id2 = manager.add(ws2, "key_1")!;

    manager.subscribeTask(id1, "task_a");

    manager.sendToTask("task_a", { type: "token", text: "hello" });

    expect(ws1.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws1.sentMessages[0])).toEqual({ type: "token", text: "hello" });
    expect(ws2.sentMessages).toHaveLength(0);
  });

  it("sends messages to session subscribers", () => {
    const ws = createMockWs();
    const id = manager.add(ws, "key_1")!;

    manager.subscribeSession(id, "sess_a");
    manager.sendToSession("sess_a", { type: "turn.done", session_id: "sess_a" });

    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0]).type).toBe("turn.done");
  });

  it("sends to specific connection", () => {
    const ws = createMockWs();
    const id = manager.add(ws, "key_1")!;

    manager.sendTo(id, { type: "pong" });

    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: "pong" });
  });

  it("does not send to closed connections", () => {
    const ws = createMockWs(3); // CLOSED state
    const id = manager.add(ws, "key_1")!;

    manager.subscribeTask(id, "task_a");
    manager.sendToTask("task_a", { type: "token", text: "test" });

    expect(ws.sentMessages).toHaveLength(0);
  });

  it("multiple connections can subscribe to the same task", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const id1 = manager.add(ws1, "key_1")!;
    const id2 = manager.add(ws2, "key_2")!;

    manager.subscribeTask(id1, "task_shared");
    manager.subscribeTask(id2, "task_shared");

    manager.sendToTask("task_shared", { type: "done", task_id: "task_shared" });

    expect(ws1.sentMessages).toHaveLength(1);
    expect(ws2.sentMessages).toHaveLength(1);
  });

  it("one connection can subscribe to multiple tasks", () => {
    const ws = createMockWs();
    const id = manager.add(ws, "key_1")!;

    manager.subscribeTask(id, "task_a");
    manager.subscribeTask(id, "task_b");

    manager.sendToTask("task_a", { type: "token", text: "a" });
    manager.sendToTask("task_b", { type: "token", text: "b" });

    expect(ws.sentMessages).toHaveLength(2);
  });

  it("tracks connection count", () => {
    expect(manager.count).toBe(0);
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const id1 = manager.add(ws1, "key_1")!;
    manager.add(ws2, "key_2");
    expect(manager.count).toBe(2);

    manager.remove(id1);
    expect(manager.count).toBe(1);
  });
});

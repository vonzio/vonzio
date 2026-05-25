import type { WebSocket } from "ws";

interface ConnectionEntry {
  ws: WebSocket;
  callerKeyId: string;
  subscribedTasks: Set<string>;
  subscribedSessions: Set<string>;
}

export class ConnectionManager {
  private connections = new Map<string, ConnectionEntry>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private maxPerCaller: number;

  constructor(opts?: { maxPerCaller?: number }) {
    this.maxPerCaller = opts?.maxPerCaller ?? 10;
  }

  start(intervalMs = 30_000): void {
    this.heartbeatInterval = setInterval(() => this.pingAll(), intervalMs);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [id, entry] of this.connections) {
      entry.ws.close();
    }
    this.connections.clear();
  }

  add(ws: WebSocket, callerKeyId: string): string | null {
    // Enforce per-caller connection limit
    let callerCount = 0;
    for (const entry of this.connections.values()) {
      if (entry.callerKeyId === callerKeyId) callerCount++;
    }
    if (callerCount >= this.maxPerCaller) return null;

    const id = `conn_${this.nextId++}`;
    this.connections.set(id, {
      ws,
      callerKeyId,
      subscribedTasks: new Set(),
      subscribedSessions: new Set(),
    });
    return id;
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  get(connectionId: string): ConnectionEntry | undefined {
    return this.connections.get(connectionId);
  }

  subscribeTask(connectionId: string, taskId: string): void {
    const entry = this.connections.get(connectionId);
    if (entry) entry.subscribedTasks.add(taskId);
  }

  subscribeSession(connectionId: string, sessionId: string): void {
    const entry = this.connections.get(connectionId);
    if (entry) entry.subscribedSessions.add(sessionId);
  }

  sendToTask(taskId: string, message: Record<string, unknown>): void {
    const json = JSON.stringify(message);
    for (const entry of this.connections.values()) {
      if (entry.subscribedTasks.has(taskId) && entry.ws.readyState === 1) {
        entry.ws.send(json);
      }
    }
  }

  sendToSession(sessionId: string, message: Record<string, unknown>): void {
    const json = JSON.stringify(message);
    for (const entry of this.connections.values()) {
      if (entry.subscribedSessions.has(sessionId) && entry.ws.readyState === 1) {
        entry.ws.send(json);
      }
    }
  }

  sendTo(connectionId: string, message: Record<string, unknown>): void {
    const entry = this.connections.get(connectionId);
    if (entry && entry.ws.readyState === 1) {
      entry.ws.send(JSON.stringify(message));
    }
  }

  get count(): number {
    return this.connections.size;
  }

  /** Returns set of session IDs that have at least one live WS connection. */
  get connectedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.connections.values()) {
      if (entry.ws.readyState === 1) {
        for (const sid of entry.subscribedSessions) ids.add(sid);
      }
    }
    return ids;
  }

  private pingAll(): void {
    for (const [id, entry] of this.connections) {
      if (entry.ws.readyState !== 1) {
        this.connections.delete(id);
        continue;
      }
      entry.ws.ping();
    }
  }
}

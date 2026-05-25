import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SessionEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

/**
 * Append-only JSONL event log per session.
 * One file per session: {dir}/{session_id}.jsonl
 *
 * Consecutive token events are buffered and flushed as a single
 * "text" event to avoid thousands of tiny writes.
 */
export class EventLog {
  private seqCounters = new Map<string, number>();
  private tokenBuffers = new Map<string, string>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private nextSeq(sessionId: string): number {
    const seq = (this.seqCounters.get(sessionId) ?? 0) + 1;
    this.seqCounters.set(sessionId, seq);
    return seq;
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  private writeEvent(sessionId: string, type: string, data: Record<string, unknown>): void {
    const event: SessionEvent = {
      seq: this.nextSeq(sessionId),
      type,
      data,
      ts: Date.now(),
    };
    appendFileSync(this.filePath(sessionId), JSON.stringify(event) + "\n");
  }

  /** Flush any buffered tokens for a session as a single "text" event. */
  flushTokens(sessionId: string): void {
    const buf = this.tokenBuffers.get(sessionId);
    if (buf) {
      this.writeEvent(sessionId, "text", { text: buf });
      this.tokenBuffers.delete(sessionId);
    }
  }

  /** Append an event. Tokens are buffered; all other types flush tokens first. */
  append(sessionId: string, type: string, data: Record<string, unknown>): void {
    if (type === "token") {
      const existing = this.tokenBuffers.get(sessionId) ?? "";
      this.tokenBuffers.set(sessionId, existing + (data.text as string ?? ""));
      return;
    }

    // Any non-token event flushes the token buffer first
    this.flushTokens(sessionId);
    this.writeEvent(sessionId, type, data);
  }

  /** Read all events for a session, optionally starting after a given seq. */
  read(sessionId: string, afterSeq = 0): SessionEvent[] {
    const path = this.filePath(sessionId);
    if (!existsSync(path)) return [];

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const events: SessionEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (event.seq > afterSeq) events.push(event);
      } catch { /* skip malformed lines */ }
    }
    return events;
  }

  /** Initialize seq counter for a session (e.g. on server restart). */
  initSeq(sessionId: string): void {
    const events = this.read(sessionId);
    if (events.length > 0) {
      this.seqCounters.set(sessionId, events[events.length - 1].seq);
    }
  }

  /**
   * Build a conversation transcript from the event log.
   * Used for context recovery when SDK resume is unavailable.
   * Returns the last N turns as a human-readable conversation.
   */
  buildTranscript(sessionId: string, maxChars = 80_000): string {
    const events = this.read(sessionId);
    if (events.length === 0) return "";

    const lines: string[] = [];

    for (const evt of events) {
      switch (evt.type) {
        case "user_message":
          lines.push(`[User]: ${evt.data.text as string}`);
          break;
        case "text":
          lines.push(`[Assistant]: ${evt.data.text as string}`);
          break;
        case "tool_use":
          lines.push(`[Tool Call]: ${evt.data.tool as string}(${JSON.stringify(evt.data.input ?? {}).slice(0, 500)})`);
          break;
        case "tool_result": {
          const output = (evt.data.output as string) ?? "";
          lines.push(`[Tool Result]: ${evt.data.tool as string} → ${output.slice(0, 500)}${output.length > 500 ? "..." : ""}`);
          break;
        }
        case "turn.done":
          lines.push("---");
          break;
      }
    }

    let transcript = lines.join("\n");

    // Trim from the beginning if too long, keeping the most recent context
    if (transcript.length > maxChars) {
      transcript = transcript.slice(-maxChars);
      const firstNewline = transcript.indexOf("\n");
      if (firstNewline > 0) {
        transcript = transcript.slice(firstNewline + 1);
      }
      transcript = "[...earlier conversation truncated...]\n" + transcript;
    }

    return transcript;
  }
}

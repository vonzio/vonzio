import type { Task, TaskResult } from "./task.js";

// Client → Server
export type ClientMessage =
  | { type: "submit"; payload: Omit<Task, "id" | "status" | "created_at" | "attempt"> }
  | { type: "cancel"; task_id: string }
  | { type: "session.start"; profile_id: string; claude_md?: string; allowed_tools?: string[] }
  | { type: "session.resume"; session_id: string }
  | { type: "session.turn"; session_id: string; message: string }
  | { type: "session.turn.cancel"; session_id: string }
  | { type: "session.end"; session_id: string }
  | { type: "session.answer"; session_id: string; answers: Record<string, string> }
  | { type: "ping" };

// Server → Client
export type ServerMessage =
  | { type: "queued"; task_id: string }
  | { type: "started"; task_id: string; container_id: string }
  | { type: "token"; task_id?: string; session_id?: string; text: string }
  | { type: "tool_use"; task_id?: string; session_id?: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; task_id?: string; session_id?: string; tool: string; output: string }
  | { type: "done"; task_id: string; result: TaskResult }
  | { type: "turn.done"; session_id: string; result: TaskResult }
  | { type: "session.ready"; session_id: string; container_id: string; resumed?: boolean }
  | { type: "session.closed"; session_id: string }
  | { type: "ask_user"; task_id?: string; session_id?: string; input: unknown }
  | { type: "cancelled"; task_id: string }
  | { type: "error"; task_id?: string; session_id?: string; code: string; message: string }
  | { type: "pong" };

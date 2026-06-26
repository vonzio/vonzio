import type { Task, TaskResult } from "./task.js";

// Local-exec (CLI `--local-exec`): the agent's file/shell tools run on the
// user's machine via the local-fs MCP. The server fans each tool call out to
// the CLI as `localtool.call` and blocks on a matching `localtool.result` /
// `localtool.deny`, correlated by `call_id`. See docs/LOCAL_EXEC.md.
export type LocalTool = "local_bash" | "local_read" | "local_write" | "local_edit";

// Client → Server
export type ClientMessage =
  | { type: "submit"; payload: Omit<Task, "id" | "status" | "created_at" | "attempt"> }
  | { type: "cancel"; task_id: string }
  | {
      type: "session.start";
      profile_id: string;
      claude_md?: string;
      allowed_tools?: string[];
      // Client-advertised capabilities. "local-exec" tells the server the CLI
      // can service localtool.call frames; the server only localizes tools when
      // this is present (it can never initiate local-exec on its own).
      capabilities?: string[];
      // Display-only label for the CLI's working directory. Never trusted
      // server-side — the path lives on the laptop; the server only echoes it
      // into the system-prompt note.
      local_root?: string;
    }
  | { type: "session.resume"; session_id: string }
  | { type: "session.turn"; session_id: string; message: string; model?: string }
  | { type: "session.turn.cancel"; session_id: string }
  | { type: "session.end"; session_id: string }
  | { type: "session.answer"; session_id: string; answers: Record<string, string> }
  | { type: "localtool.result"; session_id: string; call_id: string; output?: string; exit_code?: number }
  | { type: "localtool.deny"; session_id: string; call_id: string; reason?: string }
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
  | { type: "localtool.call"; session_id: string; call_id: string; tool: LocalTool; input: Record<string, unknown> }
  | { type: "cancelled"; task_id: string }
  | { type: "error"; task_id?: string; session_id?: string; code: string; message: string }
  | { type: "pong" };

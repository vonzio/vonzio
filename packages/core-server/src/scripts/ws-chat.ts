import "dotenv/config";
import WebSocket from "ws";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const callerKey = args[0];
const profileId = args[1];
const host = args[2] ?? "localhost:3000";

if (!callerKey || !profileId) {
  console.log("Usage: npx tsx packages/core-server/src/scripts/ws-chat.ts <caller_key> <profile_id> [host]");
  console.log("Example: npx tsx packages/core-server/src/scripts/ws-chat.ts rc_abc123 prof_xyz789");
  process.exit(1);
}

const ws = new WebSocket(`ws://${host}/v1/stream`, {
  headers: { Authorization: `Bearer ${callerKey}` },
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
let sessionId: string | null = null;

ws.on("open", () => {
  console.log("\n--- Vonzio WebSocket Chat ---");
  console.log("Type a message and press Enter to send.");
  console.log("Commands: /session (start session), /end (end session), /quit\n");
  prompt();
});

ws.on("message", (data: Buffer) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case "queued":
      process.stdout.write(`\n[queued] task ${msg.task_id}\n`);
      break;
    case "started":
      process.stdout.write(`[started] container ${msg.container_id}\n`);
      break;
    case "token":
      process.stdout.write(msg.text);
      break;
    case "tool_use":
      process.stdout.write(`\n[tool] ${msg.tool}(${JSON.stringify(msg.input)})\n`);
      break;
    case "tool_result":
      process.stdout.write(`[tool result] ${msg.output?.slice(0, 200)}\n`);
      break;
    case "done":
      process.stdout.write("\n\n[done]\n");
      prompt();
      break;
    case "turn.done":
      process.stdout.write("\n\n[turn done]\n");
      prompt();
      break;
    case "session.ready":
      sessionId = msg.session_id;
      console.log(`\n[session ready] ${msg.session_id}${msg.resumed ? " (resumed)" : ""}`);
      prompt();
      break;
    case "session.closed":
      console.log(`\n[session closed] ${msg.session_id}`);
      sessionId = null;
      prompt();
      break;
    case "error":
      console.error(`\n[error] ${msg.message}`);
      prompt();
      break;
    case "pong":
      break;
    default:
      console.log(`\n[${msg.type}]`, JSON.stringify(msg));
  }
});

ws.on("close", (code: number, reason: Buffer) => {
  console.log(`\nConnection closed (${code}: ${reason.toString()})`);
  process.exit(0);
});

ws.on("error", (err: Error) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

function prompt() {
  const prefix = sessionId ? `[session:${sessionId.slice(0, 8)}] ` : "";
  rl.question(`${prefix}> `, (input) => {
    const trimmed = input.trim();
    if (!trimmed) { prompt(); return; }

    if (trimmed === "/quit") {
      ws.close();
      return;
    }

    if (trimmed === "/session") {
      ws.send(JSON.stringify({
        type: "session.start",
        profile_id: profileId,
      }));
      return;
    }

    if (trimmed === "/end") {
      if (sessionId) {
        ws.send(JSON.stringify({ type: "session.end", session_id: sessionId }));
      } else {
        console.log("No active session");
        prompt();
      }
      return;
    }

    if (trimmed === "/ping") {
      ws.send(JSON.stringify({ type: "ping" }));
      prompt();
      return;
    }

    if (sessionId) {
      // Send as session turn
      ws.send(JSON.stringify({
        type: "session.turn",
        session_id: sessionId,
        message: trimmed,
      }));
    } else {
      // Send as one-shot task
      ws.send(JSON.stringify({
        type: "submit",
        payload: {
          prompt: trimmed,
          profile_id: profileId,
          mode: "pooled",
        },
      }));
    }
  });
}

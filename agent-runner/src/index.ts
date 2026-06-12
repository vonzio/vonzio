import { createInterface } from "node:readline";
import { runTask } from "./runner.js";
import { emit } from "./emit.js";

async function main() {
  // Read single JSON line from stdin
  const rl = createInterface({ input: process.stdin });
  let input = "";

  for await (const line of rl) {
    input = line;
    break; // Only read the first line
  }

  if (!input) {
    emit({ type: "error", error: "No input received on stdin" });
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    emit({ type: "error", error: "Invalid JSON on stdin" });
    process.exit(1);
  }

  try {
    // Judge mode: a payload with a `judge` field runs the completion judge
    // (a single model call) instead of an agent turn, and emits one verdict.
    if (payload && typeof payload === "object" && payload.judge) {
      const { judgeGoal } = await import("./judge.js");
      const verdict = await judgeGoal(payload.judge);
      emit({ type: "verdict", verdict });
      emit({ type: "exit", code: 0 });
      return;
    }
    await runTask(payload);
    emit({ type: "exit", code: 0 });
  } catch (err) {
    emit({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    emit({ type: "exit", code: 1 });
    process.exit(1);
  }
}

main();

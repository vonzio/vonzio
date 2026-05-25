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

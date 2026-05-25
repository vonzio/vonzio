import type { RunnerMessage } from "./types.js";

export function emit(msg: RunnerMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

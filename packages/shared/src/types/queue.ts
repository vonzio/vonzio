import type { Task } from "./task.js";

export interface TaskQueue {
  enqueue(task: Task): Promise<void>;
  dequeue(): Promise<Task | null>;
  cancel(taskId: string): Promise<boolean>;
  cancelBySession(sessionId: string): Promise<string | null>;
  depth(): Promise<number>;
  onReady(handler: () => void): void;
}

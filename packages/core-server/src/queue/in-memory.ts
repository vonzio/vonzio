import type { TaskQueue } from "@vonzio/shared";
import type { Task, TaskPriority } from "@vonzio/shared";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export class InMemoryTaskQueue implements TaskQueue {
  private queue: Task[] = [];
  private readyHandler: (() => void) | null = null;

  async enqueue(task: Task): Promise<void> {
    const priority = PRIORITY_ORDER[task.priority];
    // Insert in priority order, FIFO within same priority
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (PRIORITY_ORDER[this.queue[i].priority] > priority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, task);
    this.readyHandler?.();
  }

  async dequeue(): Promise<Task | null> {
    return this.queue.shift() ?? null;
  }

  async cancel(taskId: string): Promise<boolean> {
    const index = this.queue.findIndex((t) => t.id === taskId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  async cancelBySession(sessionId: string): Promise<string | null> {
    const index = this.queue.findIndex((t) => t.session_id === sessionId);
    if (index === -1) return null;
    const task = this.queue.splice(index, 1)[0];
    return task.id;
  }

  async depth(): Promise<number> {
    return this.queue.length;
  }

  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }
}

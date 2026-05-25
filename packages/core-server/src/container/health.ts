import Docker from "dockerode";
import { EventEmitter } from "node:events";

export interface HealthEvent {
  type: "oom" | "die" | "destroy";
  containerId: string;
  exitCode?: number;
}

export class HealthMonitor extends EventEmitter {
  private eventStream: NodeJS.ReadableStream | null = null;
  private running = false;

  constructor(private docker: Docker) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;

    const stream = await this.docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die", "oom", "destroy"],
        label: ["managed-by=vonzio"],
      },
    });

    this.eventStream = stream;

    stream.on("data", (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString());
        const containerId = event.Actor?.ID ?? event.id;
        const action = event.Action ?? event.status;

        if (!containerId) return;

        const healthEvent: HealthEvent = {
          type: action === "oom" ? "oom" : action === "die" ? "die" : "destroy",
          containerId,
          exitCode: event.Actor?.Attributes?.exitCode
            ? parseInt(event.Actor.Attributes.exitCode, 10)
            : undefined,
        };

        this.emit("container-event", healthEvent);
      } catch {
        // Malformed event, skip
      }
    });

    stream.on("error", () => {
      // Docker connection lost — will be detected by orchestrator health check
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    if (this.eventStream) {
      (this.eventStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      this.eventStream = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

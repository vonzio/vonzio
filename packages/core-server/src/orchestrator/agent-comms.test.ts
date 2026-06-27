import { describe, it, expect, vi } from "vitest";
import { AgentCommunicator } from "./agent-comms.js";
import type { ContainerManager } from "@vonzio/shared";

function mockManager() {
  const execCalls: string[][] = [];
  const stopContainer = vi.fn(async () => {});
  const manager = {
    execInContainer: async function* (_id: string, cmd: string[]) {
      execCalls.push(cmd);
      // no output — just record the command so we can assert on it
    },
    stopContainer,
  } as unknown as ContainerManager;
  return { manager, execCalls, stopContainer };
}

describe("AgentCommunicator.abort", () => {
  it("session abort (keepContainer) kills the agent process and keeps the container", async () => {
    const { manager, execCalls, stopContainer } = mockManager();
    const comms = new AgentCommunicator(manager);

    await comms.abort("c1", true);

    // The container must NOT be stopped — its dev servers stay alive.
    expect(stopContainer).not.toHaveBeenCalled();
    // A kill exec targeting the recorded agent PID file must be issued.
    const killCmd = execCalls.find((c) => c.join(" ").includes("vonzio-agent.pid"));
    expect(killCmd).toBeTruthy();
    const script = killCmd!.join(" ");
    expect(script).toMatch(/kill -TERM/);
    expect(script).toMatch(/kill -KILL/);
  });

  it("batch abort (no keepContainer) stops the whole container", async () => {
    const { manager, execCalls, stopContainer } = mockManager();
    const comms = new AgentCommunicator(manager);

    await comms.abort("c1", false);

    expect(stopContainer).toHaveBeenCalledWith("c1", 10);
    // No in-container kill exec in batch mode.
    expect(execCalls.find((c) => c.join(" ").includes("vonzio-agent.pid"))).toBeUndefined();
  });
});

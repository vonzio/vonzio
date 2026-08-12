import { describe, it, expect, vi } from "vitest";
import { ensureContainerRunning } from "./ensure-running.js";
import type { SessionRegistry } from "./session-registry.js";

type ContainerStatus = "running" | "paused" | "exited" | "not_found";

function makeManager(status: ContainerStatus | Error) {
  return {
    getContainerStatus: vi.fn(
      status instanceof Error
        ? () => Promise.reject<ContainerStatus>(status)
        : () => Promise.resolve(status),
    ),
    unpauseContainer: vi.fn(() => Promise.resolve()),
  };
}

function makeRegistry(sessionId: string | null) {
  return {
    getByContainer: vi.fn(() =>
      sessionId ? ({ session_id: sessionId } as never) : null,
    ),
    updateActivity: vi.fn(() => Promise.resolve()),
  } as unknown as SessionRegistry;
}

describe("ensureContainerRunning (#333)", () => {
  it("unpauses a paused container and syncs the registry", async () => {
    const cm = makeManager("paused");
    const registry = makeRegistry("sess_1");

    await ensureContainerRunning(cm, "ctr_1", registry);

    expect(cm.unpauseContainer).toHaveBeenCalledWith("ctr_1");
    expect(registry.updateActivity).toHaveBeenCalledWith("sess_1");
  });

  it("does nothing for a running container", async () => {
    const cm = makeManager("running");
    const registry = makeRegistry("sess_1");

    await ensureContainerRunning(cm, "ctr_1", registry);

    expect(cm.unpauseContainer).not.toHaveBeenCalled();
    expect(registry.updateActivity).not.toHaveBeenCalled();
  });

  it("does nothing for exited/not_found — their callers own the error path", async () => {
    for (const status of ["exited", "not_found"] as const) {
      const cm = makeManager(status);
      await ensureContainerRunning(cm, "ctr_1");
      expect(cm.unpauseContainer).not.toHaveBeenCalled();
    }
  });

  it("swallows a status-check failure (stale proxy) without throwing", async () => {
    const cm = makeManager(new Error("proxy hiccup"));
    await expect(ensureContainerRunning(cm, "ctr_1")).resolves.toBeUndefined();
    expect(cm.unpauseContainer).not.toHaveBeenCalled();
  });

  it("unpauses without a registry and tolerates an unknown container mapping", async () => {
    const cm = makeManager("paused");
    await ensureContainerRunning(cm, "ctr_1"); // no registry
    expect(cm.unpauseContainer).toHaveBeenCalled();

    const cm2 = makeManager("paused");
    const registry = makeRegistry(null); // container not in registry
    await ensureContainerRunning(cm2, "ctr_1", registry);
    expect(cm2.unpauseContainer).toHaveBeenCalled();
  });
});

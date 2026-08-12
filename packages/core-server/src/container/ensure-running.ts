import type { ContainerManager } from "@vonzio/shared";

/**
 * Unpause a container if the idle sweep paused it (issue #333). Call before
 * any exec/copy/proxy that reaches a session container OUTSIDE an active turn
 * (Files panel, terminal, ports, previews) — docker exec against a paused
 * container 409s, and a proxied HTTP request to one hangs.
 *
 * Deliberately does nothing for other states: "exited"/"not_found" keep their
 * existing error paths, which produce clearer messages than anything generic
 * we could throw here.
 */
export async function ensureContainerRunning(
  containerManager: ContainerManager,
  containerId: string,
): Promise<void> {
  const status = await containerManager
    .getContainerStatus(containerId)
    .catch(() => null);
  if (status === "paused") {
    await containerManager.unpauseContainer(containerId);
  }
}

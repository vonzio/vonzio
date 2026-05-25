import type { ContainerManager, ContainerCreateOptions, ContainerInfo } from "@vonzio/shared";

export class NoopContainerManager implements ContainerManager {
  async createContainer(): Promise<string> {
    throw new Error("Docker is disabled (DOCKER_ENABLED=false). Cannot create containers.");
  }
  async startContainer(): Promise<void> {
    throw new Error("Docker is disabled");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
  async *execInContainer(): AsyncIterable<string> {}
  async getContainerStatus(): Promise<"running" | "paused" | "exited" | "not_found"> {
    return "not_found";
  }
  async listManagedContainers(): Promise<ContainerInfo[]> {
    return [];
  }
  async getContainerIp(): Promise<string | null> {
    return "127.0.0.1";
  }
  async getContainerName(): Promise<string | null> {
    return null;
  }
  async resolveContainerId(): Promise<string | null> {
    return null;
  }
  async readFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async pauseContainer(): Promise<void> {}
  async unpauseContainer(): Promise<void> {}
  async createNamedVolume(): Promise<void> {}
  async removeNamedVolume(): Promise<void> {}
  async listImages() {
    return [];
  }
}

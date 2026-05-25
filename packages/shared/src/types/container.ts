export interface ContainerCreateOptions {
  image?: string;
  registryAuth?: { serveraddress: string; username: string; password: string };
  env: Record<string, string>;
  binds?: string[];
  cpus?: number;
  memory?: string;
  networkMode?: string;
  labels?: Record<string, string>;
}

export interface ContainerInfo {
  id: string;
  status: "running" | "exited" | "created";
  labels: Record<string, string>;
  created_at: string;
}

export interface ContainerManager {
  createContainer(opts: ContainerCreateOptions): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeout?: number): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  execInContainer(
    id: string,
    cmd: string[],
    stdin?: string,
    env?: Record<string, string>,
    user?: string,
  ): AsyncIterable<string>;
  getContainerStatus(
    id: string,
  ): Promise<"running" | "paused" | "exited" | "not_found">;
  listManagedContainers(): Promise<ContainerInfo[]>;
  /** Get the internal Docker IP address of a container */
  getContainerIp(id: string): Promise<string | null>;
  /** Get the friendly name of a container (Docker auto-generated, underscore stripped) */
  getContainerName(id: string): Promise<string | null>;
  /** Resolve a container identifier (short ID or friendly name) to the full ID */
  resolveContainerId(identifier: string): Promise<string | null>;
  /** Read a file from a container as raw bytes */
  readFile(id: string, path: string): Promise<Buffer>;
  /** Pause a running container (freezes all processes) */
  pauseContainer(id: string): Promise<void>;
  /** Unpause a paused container */
  unpauseContainer(id: string): Promise<void>;
  /** Create a named Docker volume */
  createNamedVolume(name: string): Promise<void>;
  /** Remove a named Docker volume */
  removeNamedVolume(name: string): Promise<void>;
  /** List locally available Docker images matching a filter */
  listImages(filter?: string): Promise<Array<{ name: string; tag: string; id: string; size: number; created: string }>>;
}

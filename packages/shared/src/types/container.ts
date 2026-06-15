export interface ContainerCreateOptions {
  image?: string;
  registryAuth?: { serveraddress: string; username: string; password: string };
  env: Record<string, string>;
  binds?: string[];
  cpus?: number;
  memory?: string;
  networkMode?: string;
  /** Linux capabilities to add (e.g. NET_ADMIN for WireGuard sidecars). */
  capAdd?: string[];
  /** Devices to expose into the container, formatted as Docker device
   *  strings (e.g. "/dev/net/tun" or "/dev/foo:/dev/bar:rwm"). OpenVPN
   *  sidecars require /dev/net/tun. */
  devices?: string[];
  labels?: Record<string, string>;
}

export interface ContainerInfo {
  id: string;
  status: "running" | "exited" | "created";
  labels: Record<string, string>;
  created_at: string;
}

/**
 * A live, interactive PTY session attached to a running container — the
 * backing for the dashboard's in-app console. Unlike `execInContainer`
 * (one-shot, output drained to completion), this stays open: keystrokes
 * stream in, raw terminal bytes stream out, and the shell behaves as at a
 * real terminal (tab-completion, history, colors, curses apps) because a
 * TTY is allocated.
 */
export interface TerminalSession {
  /** Write user keystrokes (raw bytes / UTF-8) to the PTY stdin. */
  write(data: string): void;
  /** Resize the PTY. `cols` = width, `rows` = height (in cells). */
  resize(cols: number, rows: number): void;
  /** Subscribe to raw PTY output. Not line-buffered or demuxed. */
  onData(cb: (chunk: Buffer) => void): void;
  /** Fires once when the shell process exits (exit code if resolvable). */
  onExit(cb: (code: number | null) => void): void;
  /** Terminate the PTY and release the underlying stream. Idempotent. */
  close(): void;
}

export interface TerminalSessionOptions {
  /** Run the shell as this container user (e.g. the non-root "agent"). */
  user?: string;
  /** Initial working directory. Defaults to /workspace. */
  cwd?: string;
  /** Shell to launch. Defaults to /bin/bash. */
  shell?: string;
  /** Initial PTY size. */
  cols?: number;
  rows?: number;
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
  /** Open an interactive PTY session (TTY) inside a running container. */
  createTerminalSession(
    id: string,
    opts?: TerminalSessionOptions,
  ): Promise<TerminalSession>;
  getContainerStatus(
    id: string,
  ): Promise<"running" | "paused" | "exited" | "not_found">;
  /** Exit details for a stopped container — used to report WHY it died (e.g.
   *  OOM-killed). Returns null when the container no longer exists. */
  getContainerExit(
    id: string,
  ): Promise<{ oomKilled: boolean; exitCode: number | null } | null>;
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
  /** Ensure a user-defined Docker network exists (idempotent). `internal: true`
   *  creates a network with NO external connectivity — the substrate for egress
   *  enforcement (feature 0005). */
  ensureNetwork(name: string, opts?: { internal?: boolean }): Promise<void>;
  /** Attach an existing container to an additional network, optionally under DNS
   *  aliases. Used to dual-home the egress proxy (external + internal). */
  connectNetwork(network: string, containerId: string, aliases?: string[]): Promise<void>;
  /** Create a named Docker volume */
  createNamedVolume(name: string): Promise<void>;
  /** Remove a named Docker volume */
  removeNamedVolume(name: string): Promise<void>;
  /** List locally available Docker images matching a filter */
  listImages(filter?: string): Promise<Array<{ name: string; tag: string; id: string; size: number; created: string }>>;
}

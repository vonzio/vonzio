/** DEFAULT port the agent container's built-in file server binds + the
 *  `{{file_server}}` preview URL / dashboard target. Operators override it via
 *  the `FILE_SERVER_PORT` env (config.ts), which flows to the container, the
 *  orchestrator, and the dashboard; this constant is the fallback default.
 *  Deliberately uncommon so a docker_access workspace publishing a normal app
 *  port (3000 / 5000 / 8000 / 8080 / …) doesn't collide with it. */
export const FILE_SERVER_PORT = 8765;

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
  /** Extra /etc/hosts entries, formatted as Docker `--add-host` strings
   *  ("hostname:ip"). Cannot be combined with a `container:` networkMode
   *  (Docker rejects it), so set this on the network-owning container — e.g.
   *  a VPN sidecar — whose /etc/hosts the attached agent then inherits. */
  extraHosts?: string[];
  /** Container runtime (Docker `--runtime`). Set to "sysbox-runc" for
   *  unprivileged nested Docker-in-Docker (feature 0001, `sysbox` mode).
   *  Undefined uses the daemon default (runc). */
  runtime?: string;
  /** Run the container privileged (Docker `--privileged`). Enables nested
   *  Docker-in-Docker without a special runtime (feature 0001,
   *  `dind-privileged` mode). Disables container confinement — self-host
   *  own-box only, never on a shared/multi-tenant host. */
  privileged?: boolean;
  /** Docker `--security-opt` entries. Defaults to `["no-new-privileges"]`
   *  (defense-in-depth) when unset; pass `[]` to drop it — required by the
   *  dind-privileged mode, whose daemon init is incompatible with no-new-privs. */
  securityOpt?: string[];
  /** Per-container PID cap (Docker `--pids-limit`). Overrides the manager's
   *  default when set (e.g. a higher ceiling for nested-DinD workspaces). */
  pidsLimit?: number;
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
  /** Resize a running container's memory limit live, no recreate (feature 0041). */
  updateContainerMemory(id: string, memory: string): Promise<void>;
  /** The container's current hard memory limit in bytes (0 = unlimited). */
  getContainerMemoryLimit(id: string): Promise<number>;
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
  /** Copy files into a directory in the container via the archive (tar)
   *  endpoint. Far faster + lighter than streaming base64 through exec stdin
   *  for large files — no ~1.34x base64 inflation and a binary bulk transfer.
   *  destDir must already exist. */
  copyToContainer(
    id: string,
    destDir: string,
    files: { name: string; content: Buffer; mode?: number; uid?: number; gid?: number }[],
  ): Promise<void>;
  /** List TCP ports currently being listened on inside the container (the
   *  running web services), so the dashboard can offer a preview/expose picker
   *  beyond whatever single port the agent happened to print. */
  listListeningPorts(id: string): Promise<number[]>;
  /** Pause a running container (freezes all processes) */
  pauseContainer(id: string): Promise<void>;
  /** Unpause a paused container */
  unpauseContainer(id: string): Promise<void>;
  /** Verify a user-defined Docker network exists with the expected posture, or
   *  create it (idempotent). `internal: true` means NO external connectivity —
   *  the substrate for egress enforcement (feature 0005); a pre-existing
   *  non-internal network of the same name is rejected (fail-closed). */
  ensureNetwork(name: string, opts?: { internal?: boolean }): Promise<void>;
  /** Create a named Docker volume */
  createNamedVolume(name: string): Promise<void>;
  /** Remove a named Docker volume */
  removeNamedVolume(name: string): Promise<void>;
  /** List locally available Docker images matching a filter */
  listImages(filter?: string): Promise<Array<{ name: string; tag: string; id: string; size: number; created: string }>>;
}

import Docker from "dockerode";
import type {
  ContainerManager,
  ContainerCreateOptions,
  ContainerInfo,
  TerminalSession,
  TerminalSessionOptions,
} from "@vonzio/shared";

const MANAGED_LABEL = "managed-by";
const MANAGED_VALUE = "vonzio";

export class DockerManager implements ContainerManager {
  constructor(
    private docker: Docker,
    private imageName: string,
    private networkName?: string,
    /** Max processes/threads per container (fork-bomb guard). 0/undefined = unlimited. */
    private pidsLimit?: number,
  ) {}

  async createContainer(opts: ContainerCreateOptions): Promise<string> {
    const imageName = opts.image ?? this.imageName;
    const memoryBytes = opts.memory ? parseMemory(opts.memory) : undefined;

    // Pull image with registry auth if provided and not already available locally
    if (opts.registryAuth) {
      let needsPull = true;
      try {
        await this.docker.getImage(imageName).inspect();
        needsPull = false;
      } catch { /* image not found locally */ }

      if (needsPull) {
        await new Promise<void>((resolve, reject) => {
          this.docker.pull(imageName, { authconfig: opts.registryAuth }, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
            if (err) return reject(err);
            if (!stream) return reject(new Error(`docker.pull(${imageName}) returned no stream`));
            this.docker.modem.followProgress(stream, (err2: Error | null) => {
              if (err2) reject(err2); else resolve();
            });
          });
        });
      }
    }

    const container = await this.docker.createContainer({
      Image: imageName,
      Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [MANAGED_LABEL]: MANAGED_VALUE,
        ...opts.labels,
      },
      HostConfig: {
        Binds: opts.binds,
        NanoCpus: opts.cpus ? Math.floor(opts.cpus * 1e9) : undefined,
        Memory: memoryBytes,
        NetworkMode: opts.networkMode ?? this.networkName,
        CapAdd: opts.capAdd,
        Devices: opts.devices?.map((d) => {
          // Accept "host" or "host:container" or "host:container:perms".
          const [host, container, perms] = d.split(":");
          return {
            PathOnHost: host,
            PathInContainer: container ?? host,
            CgroupPermissions: perms ?? "rwm",
          };
        }),
        ShmSize: 256 * 1024 * 1024, // 256MB — needed for Chrome/Chromium
        // Cap process/thread count so a runaway or hostile workload can't
        // fork-bomb the shared host kernel. Configurable; 0 = unlimited.
        PidsLimit: this.pidsLimit && this.pidsLimit > 0 ? this.pidsLimit : undefined,
        // Defense-in-depth: forbid gaining privileges via setuid/setgid
        // binaries. The agent runs non-root with no sudo, so nothing
        // legitimately escalates. Verified safe for agent-browser, which
        // drives chromium with --no-sandbox (chromium's in-container sandbox
        // isn't usable anyway; the userns sandbox also works under no_new_privs).
        SecurityOpt: ["no-new-privileges"],
      },
      WorkingDir: "/workspace",
      OpenStdin: true,
    });

    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.start();
  }

  async stopContainer(id: string, timeout = 10): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.stop({ t: timeout });
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.remove({ force });
  }

  async *execInContainer(
    id: string,
    cmd: string[],
    stdin?: string,
    env?: Record<string, string>,
    user?: string,
  ): AsyncIterable<string> {
    const container = this.docker.getContainer(id);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!stdin,
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      User: user,
    });

    const stream = await exec.start({
      hijack: true,
      stdin: !!stdin,
    });

    if (stdin) {
      // Swallow write-side errors: when the process exits before consuming all
      // of stdin (a fast crash, or a model error on a big payload), the pipe
      // breaks with EPIPE. That must NOT crash us — the process's real output
      // is on stdout, which we still drain below. Without this handler the
      // error is unhandled and surfaces as a cryptic "write EPIPE".
      stream.on("error", () => { /* broken pipe — handled via stdout below */ });
      const buf = Buffer.from(stdin);
      // Honor backpressure so large payloads (e.g. multi-MB knowledge docs)
      // aren't truncated by an immediate end() — wait for drain before closing.
      if (!stream.write(buf)) {
        await new Promise<void>((resolve) => {
          const done = () => { stream.off("drain", done); stream.off("error", done); stream.off("close", done); resolve(); };
          stream.once("drain", done);
          stream.once("error", done);
          stream.once("close", done);
        });
      }
      stream.end();
    }

    // Docker multiplexes stdout/stderr with 8-byte header frames when using hijack.
    // Header: [stream_type(1 byte), 0, 0, 0, size(4 bytes big-endian)]
    // We need to demux to get clean text output.
    let buffer = Buffer.alloc(0);

    try {
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          if (buffer.length < 8 + size) break;

          const payload = buffer.subarray(8, 8 + size).toString("utf8");
          buffer = buffer.subarray(8 + size);

          const lines = payload.split("\n");
          for (const line of lines) {
            if (line.trim()) yield line;
          }
        }
      }
    } catch {
      // Socket error (e.g. the process exited and broke the pipe). Whatever it
      // emitted on stdout before exiting was already yielded — stop cleanly
      // instead of throwing, so callers see the real output, not a pipe error.
    }

    // Flush any remaining data (in case stream ended mid-frame)
    if (buffer.length > 0) {
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
  }

  async createTerminalSession(
    id: string,
    opts: TerminalSessionOptions = {},
  ): Promise<TerminalSession> {
    const container = this.docker.getContainer(id);
    const cols = opts.cols && opts.cols > 0 ? Math.floor(opts.cols) : 80;
    const rows = opts.rows && opts.rows > 0 ? Math.floor(opts.rows) : 24;

    const exec = await container.exec({
      // Login shell so the user's PATH/prompt/aliases load like a real terminal.
      Cmd: [opts.shell ?? "/bin/bash", "-l"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: opts.user,
      WorkingDir: opts.cwd ?? "/workspace",
      // TERM lets the shell + curses apps (vim, htop) emit proper escapes.
      Env: ["TERM=xterm-256color"],
    });

    // With Tty:true the hijacked stream is a single RAW duplex — Docker does
    // NOT prepend the 8-byte stdout/stderr frame headers that execInContainer
    // has to demux. So output is piped straight through.
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    await exec.resize({ h: rows, w: cols }).catch(() => { /* race: pre-exit */ });

    let exited = false;
    const exitCbs: Array<(code: number | null) => void> = [];
    const fireExit = async () => {
      if (exited) return;
      exited = true;
      let code: number | null = null;
      try { code = (await exec.inspect()).ExitCode ?? null; } catch { /* gone */ }
      for (const cb of exitCbs) cb(code);
    };
    stream.on("end", () => void fireExit());
    stream.on("close", () => void fireExit());
    // A broken pipe surfaces as the exit above; don't let it crash the process.
    stream.on("error", () => { /* handled via exit */ });

    return {
      write: (data: string) => { try { stream.write(data); } catch { /* closed */ } },
      resize: (c: number, r: number) => {
        if (c > 0 && r > 0) exec.resize({ h: Math.floor(r), w: Math.floor(c) }).catch(() => {});
      },
      onData: (cb) => {
        stream.on("data", (chunk: Buffer | string) =>
          cb(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      },
      onExit: (cb) => { exitCbs.push(cb); if (exited) cb(null); },
      close: () => {
        try { stream.end(); } catch { /* already closed */ }
        try { (stream as unknown as { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
      },
    };
  }

  async getContainerStatus(
    id: string,
  ): Promise<"running" | "paused" | "exited" | "not_found"> {
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();
      if (info.State.Paused) return "paused";
      return info.State.Running ? "running" : "exited";
    } catch (err: unknown) {
      if (err && typeof err === "object" && "statusCode" in err && (err as { statusCode: number }).statusCode === 404) {
        return "not_found";
      }
      throw err;
    }
  }

  async getContainerExit(
    id: string,
  ): Promise<{ oomKilled: boolean; exitCode: number | null } | null> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return {
        oomKilled: info.State.OOMKilled === true,
        exitCode: typeof info.State.ExitCode === "number" ? info.State.ExitCode : null,
      };
    } catch {
      // Container removed (404) or inspect failed — no exit info available.
      return null;
    }
  }

  async listManagedContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${MANAGED_VALUE}`] },
    });

    return containers.map((c) => ({
      id: c.Id,
      status: c.State === "running" ? "running" : c.State === "exited" ? "exited" : "created",
      labels: c.Labels,
      created_at: new Date(c.Created * 1000).toISOString(),
    }));
  }
  async getContainerIp(id: string): Promise<string | null> {
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();

      // Check all networks for an IP
      const networks = info.NetworkSettings?.Networks;
      if (networks) {
        for (const net of Object.values(networks)) {
          if (net.IPAddress) return net.IPAddress;
        }
      }

      // Fallback to top-level IP. @types/dockerode 4 dropped IPAddress from the
      // NetworkSettings type, but the Docker API still returns it for containers
      // on the default bridge network — read it through a cast to keep the fallback.
      const topLevelIp = (info.NetworkSettings as { IPAddress?: string } | undefined)?.IPAddress;
      if (topLevelIp) return topLevelIp;

      return null;
    } catch {
      return null;
    }
  }

  async getContainerName(id: string): Promise<string | null> {
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();
      // Docker names start with "/" — strip it and remove underscores for hostname use
      const rawName = info.Name?.replace(/^\//, "") ?? "";
      return rawName.replace(/_/g, "");
    } catch {
      return null;
    }
  }

  async readFile(id: string, path: string): Promise<Buffer> {
    const container = this.docker.getContainer(id);
    const exec = await container.exec({
      Cmd: ["cat", path],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    // Collect raw stdout (demux Docker 8-byte frame headers, keep only stdout)
    const chunks: Buffer[] = [];
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

      while (buffer.length >= 8) {
        const streamType = buffer[0]; // 1 = stdout, 2 = stderr
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;

        if (streamType === 1) {
          chunks.push(Buffer.from(buffer.subarray(8, 8 + size)));
        }
        buffer = buffer.subarray(8 + size);
      }
    }

    return Buffer.concat(chunks);
  }

  async resolveContainerId(identifier: string): Promise<string | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=${MANAGED_VALUE}`] },
    });

    // Try matching by short ID first
    const byId = containers.find((c) => c.Id.startsWith(identifier));
    if (byId) return byId.Id;

    // Try matching by friendly name (underscore-stripped)
    const byName = containers.find((c) => {
      const names = c.Names?.map((n) => n.replace(/^\//, "").replace(/_/g, "")) ?? [];
      return names.includes(identifier);
    });
    return byName?.Id ?? null;
  }

  async pauseContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.pause();
  }

  async unpauseContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    await container.unpause();
  }

  async ensureNetwork(name: string, opts?: { internal?: boolean }): Promise<void> {
    const wantInternal = opts?.internal ?? false;
    let info: { Internal?: boolean; EnableIPv6?: boolean } | null = null;
    try {
      info = await this.docker.getNetwork(name).inspect();
    } catch { info = null; /* not found — create below */ }
    if (info) {
      // SECURITY: refuse to (re)use a pre-existing network whose posture is
      // weaker than required. Silently placing agents on an internet-routable
      // or IPv6-enabled network while enforcement reports "on" would be a
      // fail-OPEN bypass — the proxy/token become optional. Fail closed.
      if (wantInternal && !info.Internal) {
        throw new Error(`Network "${name}" exists but is not internal; egress enforcement requires it. Remove it (docker network rm ${name}) or point EGRESS_PROXY_NETWORK at a fresh name.`);
      }
      if (wantInternal && info.EnableIPv6) {
        throw new Error(`Network "${name}" has IPv6 enabled, which bypasses IPv4 egress filtering. Recreate it without IPv6 or point EGRESS_PROXY_NETWORK at a fresh name.`);
      }
      return;
    }
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Internal: opts?.internal ?? false,
        // Keep enforcement IPv4-only: an IPv6 path would be a second egress
        // route the proxy isn't filtering.
        EnableIPv6: false,
        Labels: { [MANAGED_LABEL]: MANAGED_VALUE },
      });
    } catch (err) {
      // Lost a create race with a concurrent dispatch — fine if it now exists.
      await this.docker.getNetwork(name).inspect().catch(() => { throw err; });
    }
  }

  async connectNetwork(network: string, containerId: string, aliases?: string[]): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({
        Container: containerId,
        EndpointConfig: aliases?.length ? { Aliases: aliases } : undefined,
      });
    } catch (err) {
      // Already connected is not an error for our idempotent callers.
      if (err instanceof Error && /already exists|endpoint with name/i.test(err.message)) return;
      throw err;
    }
  }

  async createNamedVolume(name: string): Promise<void> {
    await this.docker.createVolume({ Name: name });
  }

  async removeNamedVolume(name: string): Promise<void> {
    const volume = this.docker.getVolume(name);
    await volume.remove();
  }

  async listImages(filter?: string): Promise<Array<{ name: string; tag: string; id: string; size: number; created: string }>> {
    const images = await this.docker.listImages();
    const results: Array<{ name: string; tag: string; id: string; size: number; created: string }> = [];

    for (const img of images) {
      const tags = img.RepoTags ?? [];
      for (const tag of tags) {
        if (tag === "<none>:<none>") continue;
        if (filter && !tag.includes(filter)) continue;
        const [name, tagPart] = tag.split(":");
        results.push({
          name,
          tag: tagPart ?? "latest",
          id: img.Id.replace("sha256:", "").slice(0, 12),
          size: img.Size,
          created: new Date(img.Created * 1000).toISOString(),
        });
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name) || a.tag.localeCompare(b.tag));
  }
}

function parseMemory(mem: string): number {
  const match = mem.match(/^(\d+)([bkmg])$/i);
  if (!match) throw new Error(`Invalid memory value: ${mem}`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  return value * multipliers[unit];
}

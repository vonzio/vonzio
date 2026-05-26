import Docker from "dockerode";
import type {
  ContainerManager,
  ContainerCreateOptions,
  ContainerInfo,
} from "@vonzio/shared";

const MANAGED_LABEL = "managed-by";
const MANAGED_VALUE = "vonzio";

export class DockerManager implements ContainerManager {
  constructor(
    private docker: Docker,
    private imageName: string,
    private networkName?: string,
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
        ShmSize: 256 * 1024 * 1024, // 256MB — needed for Chrome/Chromium
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
      stream.write(stdin);
      stream.end();
    }

    // Docker multiplexes stdout/stderr with 8-byte header frames when using hijack.
    // Header: [stream_type(1 byte), 0, 0, 0, size(4 bytes big-endian)]
    // We need to demux to get clean text output.
    let buffer = Buffer.alloc(0);

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

    // Flush any remaining data (in case stream ended mid-frame)
    if (buffer.length > 0) {
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
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

      // Fallback to top-level IP
      if (info.NetworkSettings?.IPAddress) {
        return info.NetworkSettings.IPAddress;
      }

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

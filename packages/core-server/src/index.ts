import "dotenv/config";
import Docker, { type DockerOptions } from "dockerode";
import { loadConfig, type Config } from "./config.js";
import { createDB } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { DockerManager } from "./container/docker-manager.js";
import { NoopContainerManager } from "./container/noop-manager.js";
import { buildServer } from "./server.js";
import type { ContainerManager } from "@vonzio/shared";
import { NotificationBusImpl } from "./plugins/notification-bus.js";
import { McpRegistryImpl } from "./plugins/mcp-registry.js";
import { SchedulerImpl } from "./plugins/scheduler.js";
import { loadPluginsFromEnv, teardownPlugins, type LoadedPlugin } from "./plugins/loader.js";

// Picks dockerode connection params. DOCKER_HOST (Docker-CLI-compatible URL)
// wins when set — that's the path used by the bundled compose stack to route
// the daemon through docker-socket-proxy. Falls back to the legacy
// DOCKER_SOCKET unix path otherwise.
function resolveDockerEndpoint(config: Config): { dockerOpts: DockerOptions; dockerEndpoint: string } {
  if (config.DOCKER_HOST) {
    const raw = config.DOCKER_HOST;
    if (raw.startsWith("unix://")) {
      const socketPath = raw.slice("unix://".length);
      return { dockerOpts: { socketPath }, dockerEndpoint: raw };
    }
    // Accept tcp://host:port (Docker-CLI convention) and translate to plain
    // HTTP for dockerode — the proxy speaks HTTP over its TCP port, no TLS.
    const u = new URL(raw.replace(/^tcp:/, "http:"));
    const port = Number(u.port) || 2375;
    return {
      dockerOpts: { protocol: "http", host: u.hostname, port },
      dockerEndpoint: raw,
    };
  }
  return {
    dockerOpts: { socketPath: config.DOCKER_SOCKET },
    dockerEndpoint: config.DOCKER_SOCKET,
  };
}

async function main() {
  const config = loadConfig();
  const handle = createDB(config.DATABASE_URL);
  await runMigrations(handle);
  const { db, close: closeDb } = handle;

  let containerManager: ContainerManager;
  if (config.DOCKER_ENABLED) {
    const { dockerOpts, dockerEndpoint } = resolveDockerEndpoint(config);
    const docker = new Docker(dockerOpts);

    // Preflight: Docker daemon reachable?
    try {
      await docker.ping();
    } catch (err) {
      console.error(`Docker daemon unreachable at ${dockerEndpoint}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Preflight: Agent image exists?
    try {
      await docker.getImage(config.AGENT_IMAGE).inspect();
    } catch {
      console.error(`Agent image "${config.AGENT_IMAGE}" not found. Run: docker compose build`);
      process.exit(1);
    }

    containerManager = new DockerManager(docker, config.AGENT_IMAGE, config.DOCKER_NETWORK);
  } else {
    containerManager = new NoopContainerManager();
    console.log("Docker disabled — running in API-only mode (no task execution)");
  }

  const server = await buildServer({ config, db, pool: handle.pool, containerManager });

  // Plugin loader. Slots in AFTER core routes are registered (so the
  // routing table reads core > plugins in PR-merge order) and BEFORE
  // listen() (so we don't accept traffic for plugin routes that haven't
  // initialized yet). Sandboxed: a failed plugin is logged and skipped;
  // core proceeds with whichever plugins did load.
  const notificationBus = new NotificationBusImpl();
  const mcpRegistry = new McpRegistryImpl();
  const scheduler = new SchedulerImpl();
  const loadedPlugins: LoadedPlugin[] = await loadPluginsFromEnv({
    envList: config.VONZIO_PLUGINS,
    server,
    handle,
    config,
    notificationBus,
    mcpRegistry,
    scheduler,
  });

  try {
    await server.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.log.info("Shutting down...");
    // Plugins first so their teardown can flush state before the DB
    // closes. scheduler.stopAll() cancels any registered intervals
    // regardless of whether plugins remembered to clear them in their
    // own teardown -- belt-and-suspenders for badly-behaved plugins.
    await teardownPlugins(loadedPlugins, server.log);
    scheduler.stopAll();
    await server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();

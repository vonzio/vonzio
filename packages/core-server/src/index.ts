import "dotenv/config";
import Docker from "dockerode";
import { loadConfig } from "./config.js";
import { createDB } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { DockerManager } from "./container/docker-manager.js";
import { NoopContainerManager } from "./container/noop-manager.js";
import { buildServer } from "./server.js";
import type { ContainerManager } from "@vonzio/shared";

async function main() {
  const config = loadConfig();
  const handle = createDB(config.DATABASE_URL);
  await runMigrations(handle);
  const { db, close: closeDb } = handle;

  let containerManager: ContainerManager;
  if (config.DOCKER_ENABLED) {
    const docker = new Docker({ socketPath: config.DOCKER_SOCKET });

    // Preflight: Docker daemon reachable?
    try {
      await docker.ping();
    } catch (err) {
      console.error(`Docker daemon unreachable at ${config.DOCKER_SOCKET}: ${err instanceof Error ? err.message : err}`);
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
    await server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();

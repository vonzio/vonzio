import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { type DB } from "./db/index.js";
import { createTestDB } from "./db/test-utils.js";
import type { ContainerManager } from "@vonzio/shared";

function createMockManager(): ContainerManager {
  return {
    async createContainer() { return "ctr_1"; },
    async startContainer() {},
    async stopContainer() {},
    async removeContainer() {},
    async *execInContainer() {},
    async getContainerStatus() { return "running"; },
    async listManagedContainers() { return []; },
    async getContainerIp() { return "172.17.0.2"; },
    async getContainerName() { return "testcontainer"; },
    async resolveContainerId() { return null; },
    async readFile() { return Buffer.from(""); },
    async pauseContainer() {},
    async unpauseContainer() {},
    async createNamedVolume() {},
    async removeNamedVolume() {},
    async listImages() { return []; },
  };
}

const testConfig = loadConfig({
  ENCRYPTION_KEY: "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU",
  BETTER_AUTH_SECRET: "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU",
  PORT: "0",
  HOST: "127.0.0.1",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgres://localhost/test",
});

describe("server", () => {
  let handle: DB;
  let server: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    if (server) await server.close();
    if (handle) await handle.close();
  });

  it("responds to GET /health with status ok and pool info", async () => {
    handle = await createTestDB();

    server = await buildServer({
      config: testConfig,
      db: handle.db,
      pool: handle.pool,
      containerManager: createMockManager(),
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.pool).toBe("object");
    expect(typeof body.sessions).toBe("number");
  });
});

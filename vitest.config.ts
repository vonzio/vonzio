import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared/vitest.config.ts",
      "packages/plugin-api/vitest.config.ts",
      "packages/core-server/vitest.config.ts",
      "agent-runner/vitest.config.ts",
    ],
  },
});

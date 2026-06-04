import { defineConfig } from "vitest/config";

// Node-environment unit tests for the build tooling (the vonzio-plugins Vite
// plugin). The React app itself isn't unit-tested here.
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
  },
});

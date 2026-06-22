import { defineConfig } from "vitest/config";

// Node-environment unit tests: the build tooling (the vonzio-plugins Vite
// plugin) plus pure, framework-free app utilities under src (e.g. the
// open-redirect guard). Component tests are not run here.
export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});

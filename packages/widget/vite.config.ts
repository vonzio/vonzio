import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/vonzio.ts"),
      name: "Vonzio",
      formats: ["iife"],
      fileName: () => "vonzio.js",
    },
    outDir: "dist",
    minify: true,
  },
});

import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://localhost:3000",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3000",
      },
      "/admin/": {
        target: "http://localhost:3000",
      },
      "/preview": {
        target: "http://localhost:3000",
      },
      "/health": {
        target: "http://localhost:3000",
      },
    },
  },
});

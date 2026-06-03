import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import vonzioPlugins from "./vite-vonzio-plugins.js";

export default defineConfig({
  plugins: [react(), tailwindcss(), vonzioPlugins()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // Allow public-tunnel hosts (ngrok, cloudflared, localtunnel) when
    // developers need an HTTPS public URL for webhook testing -- e.g.
    // the Telegram bot webhook, which Telegram requires to be HTTPS +
    // reachable. Each leading dot is a wildcard-subdomain match.
    allowedHosts: [
      ".ngrok-free.app",
      ".ngrok.app",
      ".ngrok.io",
      ".trycloudflare.com",
      ".loca.lt",
    ],
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

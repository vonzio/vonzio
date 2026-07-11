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
    // Force a single copy of React and the dashboard registry across the app
    // and every bundled plugin frontend. Duplicate React breaks hooks/context;
    // a duplicate registry module would split registrations from the readers.
    // The registry also self-pins to globalThis as a backstop, but deduping
    // keeps external plugins (resolved from their own node_modules) on one copy.
    dedupe: ["react", "react-dom", "@vonzio/dashboard-registry"],
  },
  server: {
    port: 5173,
    // When served behind a reverse proxy on an HTTPS host (homelab `.lab` dev
    // over Traefik + mkcert), point the HMR websocket at the public 443 origin
    // so hot-reload connects. Opt-in via env so normal localhost dev is unchanged.
    ...(process.env.VITE_HMR_HOST
      ? { hmr: { host: process.env.VITE_HMR_HOST, protocol: "wss", clientPort: 443 } }
      : {}),
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
      ".lab",
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

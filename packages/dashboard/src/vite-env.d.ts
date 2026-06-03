/// <reference types="vite/client" />

// Provided at build time by ../vite-vonzio-plugins.ts. Exposes the set of
// plugin frontends the operator policy approved for bundling (§16 PR 3J.2).
declare module "virtual:vonzio-plugins" {
  export const pluginFrontends: Array<{ name: string; register: () => void }>;
}

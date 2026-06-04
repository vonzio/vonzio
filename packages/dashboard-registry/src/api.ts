// Lightweight plugin-facing surface of the dashboard registry.
//
// Re-exports just the register* functions + their type shapes — no
// entitlements context, no dashboard defaults — so a plugin's frontend that
// imports this doesn't transitively load anything heavier than the extension
// API itself. This is the canonical import for external plugins:
//
//   import { registerSettingsSection } from "@vonzio/dashboard-registry/api";

export * from "./types.js";
export * from "./registry.js";

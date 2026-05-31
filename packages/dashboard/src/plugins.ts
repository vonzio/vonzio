// Dashboard plugin loader.
//
// Imports each registered plugin's frontend entry at build time
// (vite resolves the imports statically; runtime lazy-loading is
// deferred until a real plugin needs it) and calls each plugin's
// default-exported register() function once during bootstrap.
//
// As more plugins extract, add an import + a registerPlugin() call.
// This is intentionally manual until a 4th-5th plugin justifies
// auto-discovery. The trade-off vs codegen:
//   - manual: any plugin author adding a new entry has to remember
//     this file (the dashboard build fails if the plugin's import
//     path is wrong, which is the kind of mistake you want loud)
//   - codegen: more magic, easier to add plugins, hides errors
//
// Per-plugin try/catch keeps a broken plugin from blank-screening
// the whole dashboard.

import telegramRegister from "@vonzio/plugin-telegram/frontend";

interface PluginEntry {
  name: string;
  register: () => void;
}

const plugins: PluginEntry[] = [
  { name: "telegram", register: telegramRegister },
];

/**
 * Called from main.tsx once, BEFORE the React tree mounts. By the
 * time App renders, every plugin's settings sections / nav items /
 * etc. are already in the dashboard registry, so the existing
 * <SettingsLayout> etc. render them naturally.
 */
export function registerDashboardPlugins(): void {
  for (const { name, register } of plugins) {
    try {
      register();
    } catch (err) {
      // Don't blow up the dashboard if one plugin throws -- log loudly
      // and keep going so the rest of the UI still renders.
      // eslint-disable-next-line no-console
      console.error(`[plugins] frontend register failed for "${name}":`, err);
    }
  }
}

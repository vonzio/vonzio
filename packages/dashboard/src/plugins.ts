// Dashboard plugin loader.
//
// The set of plugin frontends bundled here is decided by the OPERATOR POLICY at
// build time, not by a hardcoded list: the `vonzio-plugins` Vite plugin
// (../vite-vonzio-plugins.ts) reads vonzio-plugins.builtins.json + the operator
// policy, bundles a plugin's frontend only when it's approved
// (`approved_frontend: true`), and exposes the approved set via the virtual
// module `virtual:vonzio-plugins`.
//
// Per-plugin try/catch keeps a broken plugin from blank-screening the dashboard.

import { pluginFrontends } from "virtual:vonzio-plugins";

/**
 * Called from main.tsx once, BEFORE the React tree mounts. By the time App
 * renders, every approved plugin's settings sections / nav items / integration
 * rows are already in the dashboard registry, so the existing <SettingsLayout>
 * etc. render them naturally.
 */
export function registerDashboardPlugins(): void {
  for (const { name, register } of pluginFrontends) {
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

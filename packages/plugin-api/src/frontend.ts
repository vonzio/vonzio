// Frontend half of the plugin contract. v0.1 is intentionally minimal:
// a plugin's frontend entry is just a default-exported function called
// once at dashboard boot. The plugin registers whatever UI it needs by
// importing from `@vonzio/dashboard/registry` directly -- that registry
// already supports settings sections, nav items, topbar slots, composer
// slots, workspace header slots, onboarding steps, and routes, so
// plugins don't need a separate slot taxonomy.
//
// This file deliberately defines no slot enum and no DashboardSlots
// map: those would either duplicate the dashboard registry's types or
// drift from them. The dashboard registry IS the truth.
//
// Type-only react import keeps backend-only plugins from acquiring a
// runtime react dep.

/**
 * The shape a plugin's frontend entry point must default-export from
 * its `/frontend` module. Called once during dashboard boot. The
 * plugin imports the dashboard registry directly (e.g.
 * `import { registerSettingsSection } from "@vonzio/dashboard/registry"`)
 * and calls whichever register* methods it needs.
 *
 * Errors thrown here are caught by the dashboard's plugin loader and
 * surface as a console warning -- the rest of the dashboard keeps
 * rendering.
 */
export type PluginFrontendEntry = () => void;

// Lightweight plugin-facing surface of the dashboard registry.
//
// Re-exports just the register* functions + their type shapes. NO
// `registerDefaults` (which pulls every page + component into the
// import graph), so plugins that import this don't transitively load
// the entire dashboard internals -- their typecheck stays scoped to
// the actual extension API.
//
// Internal dashboard code (cp-dashboard, the customer SPA's own
// bootstrap) continues to use `@vonzio/dashboard/registry` which
// includes the heavyweight defaults.

export * from "./types.js";
export * from "./registry.js";

// The registry now lives in the standalone, publishable
// @vonzio/dashboard-registry package so external plugins can consume the
// register*/get* slot API from npm. This module keeps the
// `@vonzio/dashboard/registry` entry working for internal dashboard code (and
// the cp-dashboard overlay) by re-exporting it, plus the dashboard's own
// registerDefaults — which wires up first-party pages/routes and can't live in
// the generic package.
export * from "@vonzio/dashboard-registry";
export { registerDefaults } from "./defaults.js";

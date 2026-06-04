// Back-compat re-export. The lightweight plugin-facing surface now ships from
// @vonzio/dashboard-registry/api; external plugins import that package directly.
// Kept so existing `@vonzio/dashboard/registry/api` consumers keep resolving.
export * from "@vonzio/dashboard-registry/api";

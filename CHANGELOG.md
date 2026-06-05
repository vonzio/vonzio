# Changelog

All notable changes to vonzio OSS core are recorded here. Releases are cut as
`v*` git tags (CI publishes the SDK packages on tag).

## [Unreleased]

### Changed

- **Relicensed from AGPL-3.0-or-later to FSL-1.1-ALv2** (Functional Source
  License v1.1, with an Apache 2.0 future grant). vonzio stays free to run,
  self-host, fork, and modify for any purpose except offering it as a
  commercial product or service that competes with vonzio. Each release
  converts to Apache-2.0 — fully open source — two years after it ships. See
  [LICENSE](LICENSE) and [NOTICE](NOTICE).
- **Teller is no longer a built-in integration.** Bank data via the
  [Teller](https://teller.io) API has been extracted from core into the external
  `@vonzio/plugin-teller` plugin (published on npm, AGPL-3.0-or-later). Core no
  longer ships the Teller mTLS client, MCP server, Connect routes, or `TELLER_*`
  config — they live in the plugin and load through the standard plugin loader.

### Upgrade notes

- **Existing Teller enrollments are preserved but become unmanaged without the
  plugin.** Rows in `user_integrations` with `type = "teller"` are left untouched
  (no data migration). After upgrading, the dashboard no longer renders or lets
  you manage these enrollments **unless you install the plugin**:
  ```bash
  npm install @vonzio/plugin-teller
  # add @vonzio/plugin-teller to VONZIO_PLUGINS, provision the mTLS cert in
  # vonzio-plugins.json, then: vonzio plugin approve @vonzio/plugin-teller
  ```
  See the plugin's README for the operator policy + mTLS setup.
- To **drop** stale Teller enrollments without installing the plugin, delete the
  `user_integrations` rows where `type = 'teller'` directly.
- `TELLER_*` environment variables and the `/run/secrets/teller` cert mount are
  no longer read by core; move them to the plugin's configuration if you use it.

# Changelog

All notable changes to vonzio OSS core are recorded here. Releases are cut as
`v*` git tags (CI publishes the SDK packages on tag).

## [Unreleased]

### Added

- **Embeddable chat is back in OSS.** The `@vonzio/widget` drop-in script, the
  `/chat` embed page, and a Settings → **Embed** snippet generator now ship in
  the open-source core (they had briefly moved to the SaaS build). Embedding a
  self-hosted, bring-your-own-model agent in any page with one `<script>` tag is
  a core capability, not a paywalled one. Auth reuses scoped, rate-limited,
  revocable API tokens; a new `WIDGET_ALLOWED_ORIGINS` env gates which origins
  may embed the chat (CSP `frame-ancestors`; default same-origin only).

### Changed

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

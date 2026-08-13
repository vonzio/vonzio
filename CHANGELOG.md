# Changelog

All notable changes to vonzio OSS core are recorded here. Releases are cut as
`v*` git tags (CI publishes the SDK packages on tag).

## [Unreleased]

### Added

- **Sign in with Claude.** The Claude Pro/Max subscription no longer requires
  running `claude setup-token` locally: Settings → Keys and the onboarding
  wizard now offer a browser sign-in — approve on Anthropic's consent page,
  paste the short code it displays, done. Tokens are exchanged and refreshed
  SERVER-side (rotating refresh token + persisted expiry, migration 37), so
  the credential no longer silently expires the way pasted setup-tokens do.
  Pasted setup-tokens keep working unchanged. Same terms caveat as before:
  no guarantee Anthropic keeps honoring subscription tokens outside its own
  apps.

- **Lazy containers: idle chats now pause instead of burning CPU** (#333). A
  non-persistent chat session's container is `docker pause`d after
  `SESSION_IDLE_PAUSE_SECS` (default 900s) of inactivity — near-zero CPU while
  parked, instant resume on the next message (no rebuild, no context replay).
  Full teardown still happens at `SESSION_IDLE_TTL_SECS`. Playbook sessions,
  sessions with a dispatching task (incl. goal-loop rounds), pinned workspaces,
  and connected clients are never paused. Files panel, terminal, previews, and
  AskUserQuestion answers transparently resume a paused container. Resuming a
  non-persistent conversation no longer eagerly creates a container — it's
  created on the first message, so re-opening old chats to read them costs
  nothing. Logs report the CPU-idle time saved per container
  ("Paused-container savings"). Set `SESSION_IDLE_PAUSE_SECS=0` to disable.

- **Installer: `--force` flag for non-interactive purge.** `--yes` no longer
  auto-confirms the irreversible `--uninstall --purge` step — it keeps
  auto-confirming the benign prompts (deps, ports), but deleting the database
  now needs its own explicit consent: pass `--force`, or run without `--yes`
  to be prompted. `--purge --yes` without `--force` refuses with a clear
  message instead of deleting data.

### Fixed

- **Installer: purge now removes the pulled app images.** `--uninstall --purge`
  only matched the source-build image names (`vonzio-server:latest`,
  `vonzio-agent:latest`), silently leaving the ~8 GB of pulled
  `ghcr.io/vonzio/vonzio/server|agent:<tag>` images behind while reporting
  "Images removed". (`agent-base` is still kept unless `--remove-base`.)
- **Installer: port-bumped pull installs got a broken `BETTER_AUTH_URL`.** On a
  second instance the installer wrote `BETTER_AUTH_URL=http://localhost:<vite
  port>` — a port nothing listens on in pull mode (the server serves the
  dashboard itself). Auth URLs now follow the port that actually serves the
  dashboard per install mode. Pull-mode installs also stop checking/bumping the
  unused vite dashboard port entirely.
- **Per-instance egress network.** Every instance previously shared the literal
  `vonzio-egress` network: additional instances warned ("exists but was not
  created for project …") and the network was orphaned after the last
  uninstall. `EGRESS_PROXY_NETWORK=<project>-egress` is now written per install
  and passed through to the server (new compose env passthrough), with a skew
  guard so a new installer against an older release's compose files keeps the
  old shared name. Uninstall now cleans up the egress network, including the
  legacy shared one once the last instance is gone.
- **Installer: in-clone `./install.sh --dir <elsewhere>` crashed.** It treated
  the (possibly empty) target as a checkout; it now falls back to the fetch-mode
  install into that directory.
- **Installer: false "Removed legacy standalone postgres" on every uninstall.**
  Docker ≥ 25 exits 0 on `rm -f <missing container>`, defeating the message
  guard; now gated on `container inspect`. Uninstall output no longer leaks raw
  `docker volume rm` output, and the `.env` var reads no longer abort the
  uninstall mid-cleanup under `pipefail` when a var is absent.

- **GitHub App support for git providers.** Alongside the existing OAuth App and
  PAT paths, you can now connect GitHub via a **GitHub App**: per-repository
  selection (including org repos), org-owner approval handled inline by the
  install flow, and short-lived installation tokens minted on demand instead of a
  stored long-lived token. This sidesteps **"OAuth App access restrictions"**,
  which otherwise `403` an OAuth token on org repos until an owner approves the
  app. Configure `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and the private key (inline
  `GITHUB_APP_PRIVATE_KEY`, or — recommended for Docker, since compose `env_file`
  can't carry a multi-line PEM — a mounted file via `GITHUB_APP_PRIVATE_KEY_PATH`)
  to surface an "Install GitHub App" button in Settings → Integrations → Git
  providers. See [docs/SELF_HOST.md](docs/SELF_HOST.md#git-provider-access-oauth-app-vs-github-app).
  Purely additive — OAuth App and PAT connections are unchanged. (DB: adds
  `git_providers.installation_id`, migration 32.)

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

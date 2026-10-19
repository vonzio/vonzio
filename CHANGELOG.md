# Changelog

All notable changes to vonzio OSS core are recorded here. Releases are cut as
`v*` git tags (CI publishes the SDK packages on tag).

## [Unreleased]

### Added

- **Sign-in flows run on byok too.** The Claude subscription PKCE flow and
  the ChatGPT device flow now come from `@amenophis1er/byok/core/auth`; the
  two vonzio services keep only what a server owns (the encrypted, user-bound
  pending sign-in token, the stored expiry threshold, the curated Codex
  fallback list). The `ANTHROPIC_OAUTH_*` and `CODEX_OAUTH_*` endpoint and
  client-id overrides are gone with the hand-written flows.

- **The in-container gateway runs on byok.** `docker/llm-gateway.cjs` (1,368
  lines of hand-written Anthropic↔OpenAI/Codex translation) and
  `docker/ollama-proxy.cjs` are replaced by one daemon, `packages/llm-gateway`,
  bundled into the agent base image. Its `openai` and `codex` modes run each
  Agent SDK call as a `@amenophis1er/byok/core` `chat()` turn and relay the
  turn's events as Anthropic SSE as they arrive (byok 0.1.6's `onEvent`), so
  tokens still stream live; `ollama` and `passthrough` forward the Anthropic
  request as before (Bearer rewrite, tool-result image fix, egress tunnel).
  One daemon on :11434 also fixes the mid-session provider switch that used to
  leave the old mode running: the gateway is restarted whenever its mode or
  upstream changes, not only the upstream. Codex requests now carry byok's
  identity headers rather than the `CODEX_ORIGINATOR` env, which is gone.

- **Provider connections run on byok.** Key validation, model listing, the
  goal-loop's server-side judge and auto-titles now go through
  [`@amenophis1er/byok/core`](https://github.com/amenophis1er/byok) instead of
  four hand-written provider clients. One adapter
  (`services/byok-connection.ts`) maps a stored key to a byok connection, so
  every surface routes the same way. Visible changes: ChatGPT keys list the
  live Codex catalog with display names (falling back to the baked list, or
  to `CODEX_MODELS` when set) instead of a static guess; OpenAI-compatible
  keys resolve `/v1` the way byok does (OpenRouter, Gemini's OpenAI root,
  Groq and friends work as pasted); a hung provider times out instead of
  stalling the picker. The in-container gateway is unchanged for now.

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

- **Home "Start" sends on a fresh page load.** The new chat briefly saw an
  empty agent list on mount, read it as "no key" and dropped the handed-off
  task, leaving it in the composer. It now waits until an agent resolves and
  only gives up when that agent really has no key.

- **Path-mode previews load their own assets.** An app served under
  `/preview/<slug>/<port>/` that links `/static/style.css` used to fetch it
  from the dashboard and render unstyled. The proxy now prefixes root-relative
  URLs in HTML attributes (`src`, `href`, `action`, `srcset`, …), inline and
  linked CSS (`url()`, `@import`) and redirect `Location` headers, decoding
  gzip/deflate/br bodies first. Root-relative GETs built in JS fall back to a
  307 back under the preview when their Referer is a preview page.
- **Preview links no longer print their access token in chat.** Signed
  preview URLs keep `_pvt` in the link target but show a clean URL as the
  link text in the dashboard.

- **Start on Home sends the task.** Typing a task on Home and clicking
  Start now opens the workspace and sends it once the chat is ready, instead
  of leaving it in the composer for a second click. The text travels as
  navigation state and is cleared once consumed, so a reload or
  back-navigation never sends it twice.
- **A model picked in the composer runs on the key it came from.** The
  picker now always stores the chosen model together with its key, even when
  that key is the agent's own, so rebinding the agent to another key (or a
  stale copy of the agent in the dashboard) can no longer pair, say, an Ollama
  Cloud model with a ChatGPT key and hang the turn. If the stored key is
  deleted or can't be loaded, the conversation drops that model and uses the
  agent's default instead of sending it to the wrong provider.
- **An agent with no model no longer sends a Claude id to other providers.**
  Skipping onboarding and adding a key in Settings → Keys left the default
  agent with no model, so the first message on an Ollama, OpenAI-compatible
  or ChatGPT key went out as the SDK's Claude default and was rejected
  ("The 'claude-opus-4-8' model is not supported…"). A turn without a model
  now uses the key's first listed model (the baked Codex list for a ChatGPT
  key whose catalog is unavailable), or fails with "Pick a model for this
  agent in Settings" when none can be found. Attaching a ChatGPT key to a
  model-less agent now picks its default too, as Ollama and OpenAI keys
  already did. The Claude fallback lives in one place
  (`lib/default-model.ts`).
- **Provider rejections read as words, with a hint.** A rejected model call
  used to show the SDK's raw `API Error: 400 {"type":"error",…}` blob in the
  chat. The server now rewords it (in the bubble, the failed-turn message and
  the replayed history): a rejected model reads e.g. "The 'gpt-x' model is
  not supported when using Codex with a ChatGPT account. Pick a different
  model for this agent in Settings → Agents, or switch models from the model
  picker in the chat.", other structured 4xx/5xx bodies become one line with
  the status. The gateway also returns a rejected model as a 400 rather than
  a 502, so the SDK no longer retries it several times first.
- **A failed turn's bubble is no longer overwritten by the next turn.** The
  chat kept the failed turn's streaming bubble as the target for new tokens,
  so the next reply (or failure) replaced it instead of appearing below it.
- **First run goes setup → onboarding.** Creating the admin account now
  signs it in and lands on `/onboarding` instead of bouncing through
  `/login` (falls back to `/login` only if the sign-in step fails).
- **Pull installs no longer show an `Exited` agent container.** The
  image-carrier `agent` service sits behind the `images` compose profile in
  the pull overlay: `make docker-pull-oss` still pulls the image, plain `up`
  never starts it.
- **`--uninstall --purge` sweeps per-session volumes.** Session volumes
  (`vonzio-ws-*`, `vonzio-sdk-*`, `vonzio-dind-*`) are named by session id,
  so the project-prefixed match never removed them. Purge now removes them
  once no vonzio server container remains on the host, and new volumes carry
  the `managed-by=vonzio` label.
- **Docs point pull installs at `:3000`.** README and SELF_HOST.md said
  `:5173`, which only applies to build-from-source / Vite mode.

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

- **Default models follow a per-provider preference list.** When an agent or
  turn has no model, vonzio now picks the first available model from a fixed
  preference order instead of the first entry of the provider's catalog (which
  was alphabetical, so Ollama Cloud defaulted to `beam`): Claude keys prefer
  `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5`, `claude-fable-5-1`;
  ChatGPT and OpenAI keys `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-6.1-sol`, `gpt-6-astra`; Ollama `kimi-k3`, `glm-5.3-flash`. A catalog
  that can't be listed falls back to the first preference, one that lists none
  of them to its first model. Model-less Claude turns now run on that default
  instead of the SDK's own pick. The model list endpoints return the chosen
  `default_model`, which onboarding pre-selects; the keyless Claude fallback
  list and the static ChatGPT list are updated to match.

- **Self-hosted copy no longer assumes Anthropic or the hosted service.** The
  Settings › Keys header and the agent template "Needs" lists are
  provider-neutral; the login and register pages show Terms, Privacy and
  "Back to home" only when `MARKETING_URL` is set; and `EMAIL_FROM` defaults to
  `vonzio <noreply@example.com>` instead of a vonz.io address. The Settings ›
  Embed tab is hidden unless the new `EMBED_ENABLED=true` is set; the widget
  and its routes are unchanged.

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

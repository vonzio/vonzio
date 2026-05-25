<p align="center">
  <img src="packages/dashboard/public/favicon.svg" width="56" height="56" alt="vonzio">
</p>

<h1 align="center">vonzio</h1>

<p align="center">
  <strong>Self-host your own Claude Code agent platform.</strong><br>
  An open-source runtime for autonomous coding agents in isolated Docker containers.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/node-22+-green.svg" alt="Node 22+">
  <img src="https://img.shields.io/badge/postgres-17-336791.svg" alt="Postgres 17">
  <a href="https://vonzio.com">vonzio.com</a>
</p>

---

## What you get

vonzio runs Claude Code (or Ollama Cloud) agents in fresh, isolated Docker containers — one per conversation. You bring an API key, vonzio brings the orchestration: a chat UI, a workspace for files, a session that remembers, MCP tools, integrations, and an embeddable chat widget.

- 🤖 **Agent runtime** — Claude Sonnet/Opus/Haiku, Anthropic subscription tokens, and Ollama Cloud all supported
- 🐳 **Containerized sessions** — each conversation runs in its own Docker container with bind-mounted workspace
- 💬 **Chat + widget** — full dashboard for direct use, plus a `/chat` embed you can drop into any site
- 🔗 **Integrations** — GitHub/GitLab/Bitbucket OAuth, Slack, Telegram, Gmail, Teller
- 📒 **Playbooks** — scheduled or webhook-triggered agent chains with budget caps and success criteria
- 🧠 **Memory + skills** — persistent agent memories, reusable skill snippets, custom subagents
- 🔌 **MCP runtime** — bring your own MCP servers, or use the built-ins (memory, notify, gmail, teller, platform)

## Quickstart — self-host

One-line install (macOS or Linux, prompts before installing any missing dep):

```bash
curl -fsSL https://raw.githubusercontent.com/vonzio/core/main/install.sh | bash
```

The installer checks for Docker, Docker Compose v2, Node 22+, git, make, and openssl. It generates a fresh `.env` with secure random secrets, brings up postgres, runs the one-time Better Auth schema migration, and starts the stack. About 5 minutes on a warm machine.

Prefer to inspect before running? Clone-then-run uses the same script:

```bash
git clone https://github.com/vonzio/core.git
cd core
./install.sh
```

Visit **http://vonz.localhost** → `/setup` wizard creates your admin account → `/onboarding` walks you through adding an API key and picking a default model → you're in.

Full self-host guide with env reference, upgrade path, and troubleshooting: **[docs/SELF_HOST.md](docs/SELF_HOST.md)**.

## How it works

```
        ┌─────────────────────────────────────────────────────────────┐
        │                       Your machine                           │
        │                                                              │
        │   ┌───────────────┐         ┌──────────────────┐             │
        │   │   Dashboard    │─────────▶  core-server     │             │
        │   │   (React/Vite) │   WS    │  (Fastify)       │             │
        │   └───────────────┘         │                  │             │
        │          ▲                  │  Better Auth     │             │
        │          │                  │  Drizzle / PG    │             │
        │   ┌───────────────┐         │  Orchestrator    │             │
        │   │  Chat widget   │─────────▶  Container pool ─┼──┐          │
        │   │  (drop-in JS)  │         └──────────────────┘  │          │
        │   └───────────────┘                                ▼          │
        │                                       ┌──────────────────┐   │
        │                                       │  Agent container │   │
        │                                       │  (Docker)        │   │
        │                                       │  ┌────────────┐  │   │
        │                                       │  │ Claude SDK │  │   │
        │                                       │  └────────────┘  │   │
        │                                       └──────────────────┘   │
        └─────────────────────────────────────────────────────────────┘
```

**Packages** (all AGPL-3.0-or-later):

- `@vonzio/shared` — types + cross-package interfaces
- `@vonzio/core-server` — Fastify API, orchestrator, container lifecycle, MCP runtime, integrations
- `@vonzio/dashboard` — customer SPA (React)
- `@vonzio/widget` — embeddable chat widget

## Hosted option

If you'd rather not run your own postgres + Docker, **[vonzio.com](https://vonzio.com)** offers the same agent runtime as a managed multi-tenant service (with extras like teams, invites, billing, and an admin panel that aren't part of the OSS package). The SaaS is built as a proprietary control-plane that mounts onto the OSS data plane — same code, more features.

## Develop

```bash
# Host-mode dev (faster iteration on dashboard code; needs postgres)
make dev-oss

# Run all tests
make test

# Typecheck all packages
make typecheck
```

Project layout:

```
packages/
├── shared/         (OSS) types + 6 seam interfaces
├── core-server/    (OSS) Fastify API + agent runtime + DB
├── dashboard/      (OSS) customer React SPA
├── widget/         (OSS) embeddable JS widget
├── cp-server/      (proprietary) multi-tenant overlay
└── admin-dashboard/(proprietary) SaaS admin SPA
```

The proprietary packages (`cp-server`, `admin-dashboard`) are part of the SaaS deployment, not this repository's public OSS distribution. The data plane runs perfectly fine without them — `core-server` checks for `@vonzio/cp-server` at boot and logs "running single-user OSS" when absent.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the contribution flow.

## License

vonzio is licensed under **GNU AGPL-3.0-or-later** (see [LICENSE](LICENSE)).

Practical translation:
- ✅ Run vonzio on your own infrastructure for personal or commercial use, free of charge.
- ✅ Fork it, modify it, integrate it into your own product.
- ⚠️ If you operate a modified vonzio **as a network service** for third parties, you must publish your modifications under AGPL too. (This is the AGPL's defining clause — see §13 of the license.)
- ⚠️ "vonzio" and the vonzio logo are trademarks; the AGPL doesn't grant trademark rights. Rebrand if you operate a fork as a service.

See [NOTICE](NOTICE) for the full open-core architecture explanation and third-party license summary.

---

<p align="center">
  <sub>Built by <a href="https://github.com/amenophis1er">Amen Amouzou</a>. Issues and PRs welcome.</sub>
</p>

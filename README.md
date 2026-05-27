<p align="center">
  <img src="assets/logo.svg" width="64" height="64" alt="vonzio">
</p>

<h1 align="center">vonzio</h1>

<p align="center">
  The runtime for production agents — bring your own model.<br>
  Open-source, self-hostable, isolated Docker workspaces per session.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/node-22+-green.svg" alt="Node 22+">
  <img src="https://img.shields.io/badge/postgres-17-336791.svg" alt="Postgres 17">
  <a href="https://vonzio.com">vonzio.com</a>
</p>

---

## What it does

vonzio runs agents in fresh Docker containers — one per conversation. You bring a credential for any supported model provider; vonzio brings the orchestration: a chat UI, a workspace for files, a session that remembers, MCP tools, integrations, and an embeddable chat widget.

- **Provider-agnostic** — Anthropic (Claude Sonnet/Opus/Haiku), Anthropic subscription tokens, Ollama Cloud, and any OpenAI-compatible endpoint. Pick per profile or per workspace.
- **Containerized sessions** — each conversation runs in its own Docker container with a bind-mounted workspace
- **Chat surface + widget** — full dashboard for direct use, plus a `/chat` embed you can drop into any page
- **Integrations** — GitHub, GitLab, Bitbucket, Slack, Telegram, Gmail, Teller
- **Playbooks** — scheduled or webhook-triggered agent chains with budget caps and success criteria
- **Memory and skills** — persistent agent memories, reusable skill snippets, custom subagents
- **MCP runtime** — bring your own MCP servers, or use the built-ins (memory, notify, gmail, teller, platform)

## Quickstart

One-line install on macOS or Linux (it asks before installing any missing dep):

```bash
curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash
```

The installer checks for Docker, Compose v2, Node 22+, git, make, and openssl. It generates a fresh `.env` with secure random secrets, brings up postgres, runs the one-time Better Auth schema migration, and starts the stack. About five minutes on a warm machine.

If you'd rather read the script first, the clone-then-run path uses the same code:

```bash
git clone https://github.com/vonzio/vonzio.git
cd vonzio
./install.sh
```

Then visit `http://localhost:5173`. First visit lands on `/setup` to create your admin account, then `/onboarding` to add a credential and pick a default model. After that you're in.

Full self-host guide with env reference, upgrade path, and troubleshooting: [docs/SELF_HOST.md](docs/SELF_HOST.md).

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

Packages, all AGPL-3.0-or-later:

- `@vonzio/shared` — types and cross-package interfaces
- `@vonzio/core-server` — Fastify API, orchestrator, container lifecycle, MCP runtime, integrations
- `@vonzio/dashboard` — customer SPA (React)
- `@vonzio/widget` — embeddable chat widget

## Hosted option

If you'd rather skip running your own postgres and Docker, [vonzio.com](https://vonzio.com) offers the same agent runtime as a managed multi-tenant service. The SaaS adds teams, invites, billing, and an admin panel that aren't part of the OSS package, built as a proprietary control plane that mounts onto the same data plane shipped here.

## Develop

```bash
# Host-mode dev — faster iteration on dashboard code; you supply postgres
make dev-oss

# All tests
make test

# Typecheck across packages
make typecheck
```

Project layout:

```
packages/
├── shared/          types and seam interfaces
├── core-server/     Fastify API + agent runtime + DB
├── dashboard/       customer React SPA
└── widget/          embeddable JS widget
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow.

## License

vonzio is licensed under GNU AGPL-3.0-or-later. See [LICENSE](LICENSE).

Practical translation:

- Run vonzio on your own infrastructure for personal or commercial use, free of charge.
- Fork it, modify it, integrate it into your own product.
- If you operate a modified vonzio as a network service for third parties, you must publish your modifications under AGPL too (this is the AGPL's defining clause — see §13).
- "vonzio" and the vonzio logo are trademarks; the AGPL doesn't grant trademark rights. Rebrand if you operate a fork as a service.

See [NOTICE](NOTICE) for the full open-core architecture explanation and third-party license summary.

---

<p align="center">
  <sub>Built by <a href="https://github.com/amenophis1er">Amen Amouzou</a>. Issues and PRs welcome.</sub>
</p>

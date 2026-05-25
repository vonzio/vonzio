# Contributing to vonzio

Thanks for considering a contribution. This guide covers the basics; pair it with [README.md](README.md) for project context and [docs/SELF_HOST.md](docs/SELF_HOST.md) for running a local stack.

## Ground rules

- **License**: by submitting a pull request, you agree to license your contribution under the same AGPL-3.0-or-later that covers the rest of the project. No CLA is required and no copyright assignment is requested. Your name stays on your commits.
- **Issues first for non-trivial work**: open an issue describing the change before sinking days into a PR. Small fixes can go straight to PR.
- **One change per PR**: easier to review, easier to revert.
- **No AI-slop**: if you used an AI assistant to write the code, that's fine; you're still responsible for understanding every line and the change reading like a human wrote it.

## Local setup

The full recipe is in [docs/SELF_HOST.md](docs/SELF_HOST.md). The short version:

```bash
git clone https://github.com/vonzio/core.git
cd vonzio
npm install

# Postgres (one-time)
docker run --rm -d -e POSTGRES_DB=vonzio -e POSTGRES_USER=vonzio \
  -e POSTGRES_PASSWORD=vonzio_dev -p 5432:5432 --name vonzio-pg postgres:17-alpine

cp .env.example .env   # add ENCRYPTION_KEY + BETTER_AUTH_SECRET
make better-auth-migrate
make dev-oss           # host mode — fastest iteration
```

Visit http://localhost:5173, run through `/setup` → `/onboarding`, you're in.

For the full Docker stack with Traefik (mimics production), use `make docker-dev-oss` instead.

## Before you push

```bash
make typecheck     # all 5 packages typecheck clean
make test          # all non-DB tests pass (DB tests need a running postgres)
```

If you touched dashboard UI, take a screenshot and include it in the PR description.

## Project conventions

- **Two-space indentation, semicolons, double-quoted strings.** Mirror the surrounding file.
- **Commit messages**: imperative mood, scoped prefix when it's clear (`fix(dashboard):`, `feat(core-server):`). Body wraps at ~72 chars. Explain *why*, not just *what*.
- **Never commit secrets.** `.env`, real API keys, database dumps. The `.gitignore` covers the obvious cases; double-check your diff.
- **Tests**: integration tests hit a real postgres (no mocks for the DB). Unit tests are fine in-memory. See `packages/core-server/src/orchestrator/retry.test.ts` for a good example of a focused unit test.

## What's in scope

The OSS repository (`vonzio/core`) covers the **data plane**: agent runtime, dashboard, widget, integrations runtime, MCP, sessions, playbooks, memories. Anything a single-user self-hoster needs.

What's **not** in this repo (and won't be accepted as a PR here):
- Multi-tenant signup, invites, plans, billing (lives in the proprietary `cp-server` package, behind a stable interface seam).
- The SaaS admin SPA.

If you want to extend the multi-tenant story, the right approach is to build it on top of the same six interface seams (`ProfileResolver`, `IntegrationCredentials`, `SecretVault`, `TokenValidator`, `QuotaConfig`, `UsageEmitter` — all in `@vonzio/shared`) and publish your own private overlay package. We did exactly this for the hosted vonzio service.

## What we're especially looking for

- Bug fixes (anything reproducible).
- New MCP servers / integrations (Linear, Notion, Jira, additional bank providers).
- Self-host quality-of-life: better CLI tools, recovery scripts, backup/restore.
- Documentation improvements — especially around the orchestrator, container lifecycle, and the integration runtime.
- Performance work on the orchestrator and container pool (real benchmarks please).
- Translations (the dashboard is currently English-only; a clean i18n pass would be welcome).

## Getting help

- **Bug reports / feature requests**: [GitHub Issues](https://github.com/vonzio/core/issues)
- **Questions, design discussions**: [GitHub Discussions](https://github.com/vonzio/core/discussions)
- **Security**: email `security@vonz.io` instead of filing a public issue. Please don't open public issues for vulnerabilities.

# Security Policy

## Supported versions

vonzio is pre-1.0; only the latest `v0.x.y` tag receives security fixes.
Older tags are not patched — please upgrade before reporting.

| Version | Supported |
| ------- | --------- |
| Latest `v0.x.y` | ✅ |
| Older `v0.x.y`  | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Report security vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/vonzio/vonzio/security/advisories/new)
form. The maintainers will:

1. Acknowledge the report within **3 business days**.
2. Triage and confirm the issue (or explain why it isn't one).
3. Coordinate a fix and disclosure timeline with you.

If GitHub's form is unavailable, email **security@vonz.io** with:

- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept welcome but not required).
- Affected version(s) / commit SHA.
- Your preferred attribution for the public disclosure (or "anonymous").

## Scope

In-scope:

- The core agent runtime (`packages/core-server`, `packages/shared`,
  `agent-runner/`).
- The dashboard SPA (`packages/dashboard`).
- The reference Docker compose stack under `docker/`.
- The install script (`install.sh`).

Out-of-scope:

- Issues in upstream dependencies — please report those upstream first.
  Cross-link the upstream advisory in your report if vonzio is affected
  transitively.
- Self-hosted misconfigurations (exposed Postgres, unsecured Docker
  socket, etc.) — these are deployment hygiene, not vulnerabilities in
  the project.
- Findings that require physical access to the host or root on the
  Docker daemon.

## Disclosure

We follow **coordinated disclosure**:

- Critical issues: fix within 7 days of confirmation, then public advisory.
- High / medium: fix within 30 days, then public advisory.
- Low: rolled into the next minor release with notes in CHANGELOG.

Public CVEs are filed via GitHub Security Advisories. Reporters are
credited unless they request anonymity.

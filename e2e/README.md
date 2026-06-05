# End-to-end smoke tests

Browser-level tests (Playwright) that drive the **dockerized OSS stack** the way
a brand-new self-hoster does. They guard the one class of regression nothing
else catches: **first-run is broken** — the `/setup` wizard, login, and the
hand-off into onboarding.

Scope is intentionally tiny. E2E is the most expensive and flakiest test tier,
so it covers only the critical path; breadth lives in the unit suites
(`npm test`). The dashboard otherwise has no browser-level coverage, so this is
the highest-value safety net to grow first.

## What's covered

| Spec | Flow | Provider needed? |
| --- | --- | --- |
| `tests/first-run.spec.ts` | `/setup` → create admin → `/login` → sign in → routed to `/onboarding` → "pick a provider" renders | No — deterministic & free |
| `tests/chat.spec.ts` | send a message → assistant reply | Yes — **skipped**, behind a mock (see below) |

## Running it

The suite needs a **fresh** stack (empty DB, so the first visit lands on
`/setup`; the wizard 409s once an admin exists).

```bash
# 1. Boot a fresh OSS stack in one terminal
make docker-dev-oss          # dashboard :5173, API :3000

# 2. First time only: install the Playwright browser
make e2e-install

# 3. Run the smoke
make e2e
```

Re-running against a dirty DB fails at step 1 of `first-run` (the `/setup`
409) — recreate the stack to reset:

```bash
cd docker && docker compose --env-file ../.env \
  -f docker-compose.yml -f docker-compose.dev.yml down -v
```

Point the suite at a different origin with `VONZIO_E2E_BASE_URL`
(default `http://localhost:5173`).

## CI

`.github/workflows/e2e.yml` runs this **gated**, not on every PR: only when
`packages/dashboard/**`, `packages/core-server/**`, or `e2e/**` change, plus
manual `workflow_dispatch`. The job boots its own fresh stack, waits for
`/health`, runs the suite, and uploads the Playwright HTML report + failure
traces as an artifact. It's deliberately off the every-PR required-checks path
because spinning the full stack costs a few minutes.

## Finishing the chat test

`tests/chat.spec.ts` is written but `test.describe.skip`-ped. The chat path
calls the model provider **server-side** (inside the agent container), so the
browser can't intercept it; `helpers/mock-provider.ts` is a real, tiny
OpenAI-compatible stub (`/v1/models` + `/v1/chat/completions`, streaming and
not) that returns a canned reply. Two wiring steps remain, both documented
inline in the spec:

1. **Reachability** — make the mock's URL resolvable from the agent container
   (`host.docker.internal` with `extra_hosts`, or a sidecar on the compose
   network).
2. **Credential** — create an OpenAI-compatible credential pointing at the mock
   via the API with an admin session, then set the profile model. Drive the
   rest through the UI and assert the canned reply appears.

Un-skip once both are wired.

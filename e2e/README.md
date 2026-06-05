# End-to-end tests

Browser-level tests (Playwright) that drive the **dockerized OSS stack** the way
a brand-new self-hoster does. They guard the regressions nothing else catches:
**first-run is broken** (the `/setup` wizard, login, onboarding hand-off) and
**chat is broken** (send a message, get a reply).

Scope is intentionally tiny. E2E is the most expensive and flakiest test tier,
so it covers only the critical path; breadth lives in the unit suites
(`npm test`). The dashboard otherwise has no browser-level coverage, so this is
the highest-value safety net to grow first.

## What's covered

| Spec | Flow | Cost |
| --- | --- | --- |
| `tests/first-run.spec.ts` | `/setup` → create admin → `/login` → sign in → routed to `/onboarding` ("pick a provider") | Light — no provider, no agent |
| `tests/chat.spec.ts` | configure a mock-backed agent → send a message → assistant reply | Heavy — spawns a **real agent container** against a **mock LLM** |

## Running it

Each suite needs a **fresh** stack (empty DB, so the first visit lands on
`/setup`; the wizard 409s once an admin exists). The easiest way is the
self-contained make targets — they boot their **own fully-isolated stack**
(separate docker network + volumes + alt ports `5273/3100`) and tear it down,
so they never touch a running `make docker-dev` stack or its DB:

```bash
make e2e-install      # one-time: install the Playwright browser

make e2e-fresh        # first-run smoke on a throwaway isolated stack
make e2e-chat         # chat round-trip on an isolated stack + mock LLM
```

`make e2e-chat` needs the agent image (`vonzio-agent:latest`); the script builds
it (agent-base + agent, ~5-8 min) on first run if it's missing.

### Against an already-running stack

If you already have a fresh stack up (`make docker-dev-oss`), you can run the
first-run smoke directly against it:

```bash
make e2e                                  # uses VONZIO_E2E_BASE_URL or :5173
```

This fails if the DB isn't fresh (the `/setup` 409) — that's what `make
e2e-fresh` avoids by spinning its own throwaway DB.

## How the chat mock works

The agent uses `@anthropic-ai/claude-agent-sdk`, so the chat path speaks the
**Anthropic Messages API** from *inside* the spawned agent container — the
browser can't intercept it. So instead we redirect the agent's upstream:

- `OLLAMA_BASE_URL` is env-overridable (`packages/core-server/.../ollama-service.ts`).
  `docker/docker-compose.e2e.yml` points it at the `mock-llm` service.
- The test configures the profile with the **ollama** provider, whose
  in-container proxy (`docker/ollama-proxy.cjs`) forwards the agent's LLM calls
  to `OLLAMA_TARGET_URL` (= `OLLAMA_BASE_URL`) — i.e. to the mock.
- `helpers/mock-llm-server.cjs` is a tiny Anthropic-shaped endpoint: `GET
  /v1/models` (for the model picker / credential validation) and `POST
  /v1/messages` (streaming + not) returning a canned `E2E pong`. No real
  provider, no API key, no cost.

The overlay also gives this stack its own network and pins auth to the alt-port
origin, so it's safe to run alongside your dev stack.

## CI

- **`e2e.yml`** — the **first-run** smoke. Gated (only on `packages/dashboard/**`,
  `packages/core-server/**`, `docker/**`, `e2e/**` changes, plus
  `workflow_dispatch`), not an every-PR required check. Boots a fresh stack,
  waits for `/health`, runs the suite, uploads the report on failure.
- **`e2e-full.yml`** — the **full** heavy E2E: first-run **and** chat
  (real agent image + mock LLM). Reusable (`workflow_call`) + `workflow_dispatch`.
  It is the **release gate**: `release.yml` calls it and makes the GitHub
  release + npm publish `needs:` it, so a broken setup/login/onboarding/chat on
  the tagged commit stops the release. Run it by hand any time before tagging.
  Not an every-PR gate — it builds the heavy agent image (~5-8 min).

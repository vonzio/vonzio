# plugin-hello-attacks

The negative-test corpus from `docs/PLUGIN_LOADER_SPEC.md` §12. Each entry
below deliberately violates a loader invariant; the **expected outcome** is the
loader's honest contract — a refusal where the gate refuses, an audit signal
where the gate is informational, or a documented limitation where the loader
cannot prevent the attack at all (the last two are NOT security guarantees).

The runnable assertions live in
`packages/core-server/src/plugins/attack-corpus.test.ts` (drives the real gate
functions; runs in CI). This directory documents the corpus for plugin authors
learning the contract boundaries.

| Attempt | Gate | Expected outcome |
|---|---|---|
| undeclared-capability | membrane | `CapabilityViolationError` + audit |
| membrane-bypass (reflect / spread / bind) | membrane | only declared surfaces exposed |
| db-cross-schema (+ via-join, via-cte) | scoped DB | `DbScopeViolationError` |
| db-raw-sql | scoped DB | refused for `db.scoped` |
| outbound-undeclared-host | ctx.http | `OutboundHostViolationError` |
| outbound-private-ip | safeFetch SSRF | `SsrfBlockedError` |
| policy-missing-capability | policy | `policy_capability_drift` refusal |
| policy-hash-mismatch | policy | `policy_hash_mismatch` refusal (external) |
| frontend-entry-external-unapproved | policy | `unapproved_frontend` refusal + hint |
| frontend-entry-external-approved | policy | loads |
| root-combination | loader | refused pre-import (external) |
| manifest-typo (unknown field) | manifest | refused (`manifest_invalid`) |
| prototype-pollution | intrinsics snapshot | logged loudly; **boot continues** (§2.10) |
| raw-fetch (globalThis.fetch) | AsyncLocalStorage | audit anomaly; **not blocked** (§10) |
| import-time-side-effect | — | **not prevented** (documented limitation) |
| dashboard-csp-bypass, dev-server-unapproved-frontend | — | deferred to PR 3J.2 (CSP + bundling) |
| outbound-websocket-undeclared | — | n/a in v1 (PluginHttp exposes `fetch` only) |

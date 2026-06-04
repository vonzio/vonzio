# vonzio plugin examples

Worked examples for the external plugin loader (see
[`docs/PLUGIN_LOADER_SPEC.md`](../docs/PLUGIN_LOADER_SPEC.md) and
[`docs/PLUGINS.md`](../docs/PLUGINS.md)).

## `plugin-hello/`

The minimal "good" plugin. Declares exactly three capabilities —
`storage.kv`, `notifications.channel`, `http.outbound` — which is the audit
signal a small plugin gives: the operator sees precisely what it can reach.
Its manifest lives in `package.json` under the `vonzio` block; its
`src/index.ts` shows the capability-shaped `ctx` in use (per-plugin KV, a
claimed notification kind, an audited outbound call).

To run it: install the package, declare it in `VONZIO_PLUGINS`, approve it
with `make plugin ARGS="approve @vonzio/plugin-hello"`, and restart.

## `plugin-hello-attacks/`

The negative corpus: each module deliberately violates a loader invariant.
The **runnable regression suite** that asserts every documented outcome lives
at
[`packages/core-server/src/plugins/attack-corpus.test.ts`](../packages/core-server/src/plugins/attack-corpus.test.ts)
— it drives the real gate functions (membrane, scoped DB, outbound HTTP,
policy cross-check, intrinsics snapshot). The corpus proves the gates fire,
documents the gates that are informational-only (prototype-pollution
detection, raw-fetch anomaly), and names the limitations the loader cannot
prevent (import-time side effects) — the loader's honest contract (§2).

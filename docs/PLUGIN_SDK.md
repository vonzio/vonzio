# Plugin SDK — building external plugins

A vonzio plugin can be a **built-in** (a workspace package in this repo, like
`@vonzio/plugin-slack` / `@vonzio/plugin-telegram`) or **external** — an npm
package in its own repository that an operator installs and approves. This doc
is for external plugins. For the contract itself see
[PLUGINS.md](./PLUGINS.md); for the loader's guarantees see
[PLUGIN_LOADER_SPEC.md](./PLUGIN_LOADER_SPEC.md).

## The published SDK packages

External plugins consume these from public npm:

| Package | Use |
|---|---|
| `@vonzio/plugin-api` | The backend contract: `VonzioPlugin`, `PluginContext`, capability types, `validateManifest`, the error classes. |
| `@vonzio/plugin-api/policy` | Node-only policy helpers (`hashPackageDir`, `loadPolicies`, …) — only needed by tooling, not by a plugin's runtime. |
| `@vonzio/plugin-api/frontend` | The `PluginFrontendEntry` type for a plugin's `frontend.tsx`. |
| `@vonzio/dashboard-registry/api` | The frontend slot API a plugin's `frontend.tsx` calls — `registerIntegrationRow`, `registerSettingsSection`, `registerWorkspaceHeaderSlot`, … plus the slot prop types. `react` + `lucide-react` are peer deps. |
| `@vonzio/shared` | Shared types (`Profile`, `Workspace`, …) referenced by the contract. Installed transitively. |

```bash
npm install @vonzio/plugin-api                 # backend-only plugin
npm install @vonzio/dashboard-registry react lucide-react   # + a dashboard frontend
```

A plugin's `frontend.tsx` default-exports a `PluginFrontendEntry` (`() => void`)
that calls `register*` from `@vonzio/dashboard-registry/api`:

```tsx
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";
import { registerIntegrationRow } from "@vonzio/dashboard-registry/api";
import { MyRow } from "./MyRow.js";

const register: PluginFrontendEntry = () => {
  registerIntegrationRow({ id: "my-plugin", component: MyRow, section: "data-sources" });
};
export default register;
```

Then, on the operator's host: declare it in `VONZIO_PLUGINS`, approve it
(`vonzio plugin approve <name>`, or `--frontend` for UI), and restart. The
loader hash-attests external packages, so any change requires re-approval. See
the [loader spec §2-§4](./PLUGIN_LOADER_SPEC.md) for the external-plugin trust
model and the capability rules (notably: externals **cannot** use `db.access`
and cannot combine `integrations.read.decrypted` with `db.scoped`).

## How the SDK is published (maintainers)

The source packages stay `private` with `exports` pointing at `./src/*.ts` so the
monorepo's no-build, run-from-source dev flow (tsx/Vite/vitest) is untouched.
Publishing builds a self-contained package from `dist/`:

- `scripts/prepare-sdk-dist.mjs` compiles to `dist/` and writes a fresh
  `dist/package.json` (no `private`, `exports` → built `./*.js` + `./*.d.ts`,
  workspace `*` deps pinned to `^version`).
- **Inspect locally:** `make publish-sdk-dryrun` (builds + `npm pack`, no publish).
- **Publish:** the `release.yml` `publish-sdk` job runs on a `v*` tag — it builds
  + `npm publish`es `@vonzio/shared`, `@vonzio/plugin-api`, then
  `@vonzio/dashboard-registry`. Each publishes at its own `package.json` version
  (idempotent: an already-published version is skipped). To ship a new SDK
  version, bump the package's `version` and push a tag. Requires an `NPM_TOKEN`
  repo secret. Never `npm publish` locally.

`@vonzio/dashboard-registry` is the same source the dashboard itself uses — the
dashboard re-exports it under `@vonzio/dashboard/registry` for internal code, and
the built-in slack/telegram plugins import `@vonzio/dashboard-registry/api`
exactly as an external plugin would, so the published path is dogfooded.

#!/usr/bin/env node
// CI lint: forbid raw `fetch(` in BACKEND plugin code. Plugins must route
// outbound HTTP through the audited `ctx.http.fetch` (SSRF + outboundHosts
// allowlist + per-call audit) — see docs/PLUGIN_LOADER_SPEC.md §10.
//
// Scope: packages/plugins/<name>/src/**/*.ts, EXCLUDING:
//   - any `dashboard/` directory + `frontend.tsx` (browser code; uses the
//     real global fetch against the plugin's own backend — no ctx there)
//   - *.test.ts
// Allowed: `ctx.http.fetch(` / `.http.fetch(` / `http.fetch(` (the audited
// surface) — these are not flagged.
//
// Exit 1 (with offenders printed) if any bare backend `fetch(` is found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(repoRoot, "packages", "plugins");

/** Recursively collect backend .ts files under a plugin's src/. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dashboard" || entry.name === "node_modules") continue;
      out.push(...collect(abs));
    } else if (entry.isFile()) {
      if (!entry.name.endsWith(".ts")) continue; // skips .tsx frontend
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(abs);
    }
  }
  return out;
}

// Bare `fetch(` not immediately preceded by `.` or a word char (so
// `ctx.http.fetch(` / `client.fetch(` / `safeFetch(` are not matched, but
// `fetch(` and `globalThis.fetch(`... note: we DO want to flag globalThis.fetch
// too, so additionally flag `globalThis.fetch(`).
const RAW = /(?<![.\w])fetch\s*\(/;
const GLOBAL = /\bglobalThis\.fetch\s*\(/;

const offenders = [];
let pluginRoots = [];
try {
  pluginRoots = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(pluginsDir, d.name, "src"));
} catch {
  // no plugins dir — nothing to lint
}

for (const src of pluginRoots) {
  let files = [];
  try {
    if (!statSync(src).isDirectory()) continue;
    files = collect(src);
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      if (RAW.test(line) || GLOBAL.test(line)) {
        offenders.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

if (offenders.length) {
  console.error("no-raw-fetch-in-plugins: backend plugin code must use ctx.http.fetch, not raw fetch:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(`\n${offenders.length} offending call(s). Route them through ctx.http.fetch (§10).`);
  process.exit(1);
}

console.log("no-raw-fetch-in-plugins: OK (no bare backend fetch in plugin code)");

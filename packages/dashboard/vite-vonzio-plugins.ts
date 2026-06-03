// Vite plugin: bundle a plugin's FRONTEND into the dashboard only when the
// operator policy approves it (built-ins always; externals iff
// `approved_frontend: true`), exposing the approved set via the virtual module
// `virtual:vonzio-plugins`. Also stamps a per-request CSP nonce PLACEHOLDER onto
// every <script> tag (core-server injects the real nonce at serve time) and
// emits `dist/.plugins.json` so the server can verify build↔runtime parity.
//
// See docs/PLUGIN_LOADER_SPEC.md §16 PR 3J.2.
//
// WHY THIS FILE INLINES hashPackageDir / findRepoRoot / classifySource instead
// of importing them from @vonzio/plugin-api/policy (which core-server uses):
// Vite loads this config through esbuild's config bundler, which EXTERNALIZES
// node_modules deps and then lets plain Node import them — but the @vonzio
// workspace packages are TS source with `.js` import specifiers that only a TS
// loader (tsx / Vite's own transform) resolves. So value imports from @vonzio
// fail at config-load time. Type-only imports are erased by esbuild and are
// fine. The inlined hashPackageDir MUST stay byte-identical to
// @vonzio/plugin-api/policy's — `vite-vonzio-plugins.test.ts` asserts that.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Plugin } from "vite";
// Type-only — erased by esbuild, so no runtime resolution of @vonzio.
import type { PolicyEntry } from "@vonzio/plugin-api";

const VIRTUAL_ID = "virtual:vonzio-plugins";
const RESOLVED_VIRTUAL_ID = "\0" + VIRTUAL_ID;
/** Replaced per-request by core-server with a fresh CSP nonce. */
export const NONCE_PLACEHOLDER = "__VONZIO_NONCE__";

// ── Inlined pure helpers (mirror @vonzio/plugin-api/policy) ──────────────────

/** Walk up to the monorepo root (nearest package.json with a `workspaces`
 *  field). Mirrors findRepoRoot in @vonzio/plugin-api/policy. */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        /* ignore malformed package.json while walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** SHA-256 of a package directory (excl. node_modules, symlinks refused).
 *  MUST stay byte-identical to @vonzio/plugin-api/policy hashPackageDir — the
 *  parity check compares these hashes. Guarded by a drift test. */
export function hashPackageDir(root: string): string {
  const realRoot = path.resolve(root);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(
          `refusing to hash package "${realRoot}": contains a symlink (${path.relative(realRoot, abs)}); symlinks are not allowed in plugin packages`,
        );
      }
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(path.relative(realRoot, abs));
    }
  };
  walk(realRoot);
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path.join(realRoot, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** builtin ⇔ under <repoRoot>/packages AND named in the builtins policy. */
function classifySource(realRoot: string, repoRoot: string, builtinNames: ReadonlySet<string>, name: string): "builtin" | "external" {
  const packagesDir = path.join(path.resolve(repoRoot), "packages") + path.sep;
  return path.resolve(realRoot).startsWith(packagesDir) && builtinNames.has(name) ? "builtin" : "external";
}

/** Light policy read for the build tool: parse the builtins + operator policy
 *  JSON. The runtime loader does the strict validation; here a malformed file
 *  surfaces as a build error (JSON.parse throw), which is the right behaviour. */
export interface LoadedFrontendPolicy {
  entries: Map<string, PolicyEntry>;
  builtinNames: Set<string>;
  operatorPath: string | null;
}

export function loadFrontendPolicy(repoRoot: string, env = process.env, cwd = process.cwd()): LoadedFrontendPolicy {
  const read = (p: string): Record<string, PolicyEntry> => {
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { plugins?: Record<string, PolicyEntry> };
    return parsed.plugins ?? {};
  };
  const builtins = read(path.join(repoRoot, "vonzio-plugins.builtins.json"));
  const operatorPath = env.VONZIO_PLUGIN_POLICY ?? path.join(cwd, "vonzio-plugins.json");
  const operator = read(operatorPath);
  const entries = new Map<string, PolicyEntry>();
  for (const [name, e] of Object.entries(builtins)) entries.set(name, e);
  for (const [name, e] of Object.entries(operator)) entries.set(name, e); // operator wins
  return {
    entries,
    builtinNames: new Set(Object.keys(builtins)),
    operatorPath: existsSync(operatorPath) ? operatorPath : null,
  };
}

export interface ApprovedFrontend {
  name: string;
  source: "builtin" | "external";
  hash: string;
  specifier: string;
}

export interface PluginsJson {
  plugins: Array<{ name: string; source: string; hash: string }>;
  policyPath: string | null;
  policyHash: string | null;
}

/** Resolve an installed package's real root via the monorepo node_modules.
 *  Robust against the exports-only packages (require.resolve / import.meta.
 *  resolve choke on their export maps). null if not installed. */
export function resolvePackageRootViaNodeModules(repoRoot: string, name: string): string | null {
  const guess = path.join(repoRoot, "node_modules", ...name.split("/"));
  if (!existsSync(path.join(guess, "package.json"))) return null;
  return realpathSync(guess);
}

function validateFrontendEntry(root: string, frontendEntry: string): void {
  const abs = path.resolve(root, frontendEntry);
  if (!existsSync(abs)) throw new Error(`frontendEntry "${frontendEntry}" does not exist`);
  const real = realpathSync(abs);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`frontendEntry "${frontendEntry}" escapes the package root`);
  }
}

export interface ComputeApprovedArgs {
  policy: LoadedFrontendPolicy;
  repoRoot: string;
  resolveRoot?: (repoRoot: string, name: string) => string | null;
  hash?: (root: string) => string;
}

/**
 * Compute the set of plugin frontends to bundle. Built-ins are always bundled
 * (their builtins-policy entry has approved_frontend: true); externals only
 * when the operator policy approves the frontend. Refuses (throws) if an
 * approved plugin isn't installed, or (external) its hash ≠ approved_hash_sha256.
 */
export function computeApprovedFrontends(args: ComputeApprovedArgs): ApprovedFrontend[] {
  const { policy, repoRoot } = args;
  const resolveRoot = args.resolveRoot ?? resolvePackageRootViaNodeModules;
  const doHash = args.hash ?? hashPackageDir;

  const out: ApprovedFrontend[] = [];
  for (const name of [...policy.entries.keys()].sort()) {
    const entry = policy.entries.get(name)!;
    if (entry.approved_frontend !== true) continue;

    const root = resolveRoot(repoRoot, name);
    if (!root) {
      throw new Error(`vonzio-plugins: "${name}" is approved for frontend bundling but is not installed (no node_modules/${name}).`);
    }
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      vonzio?: { frontendEntry?: string };
    };
    const frontendEntry = pkg.vonzio?.frontendEntry;
    if (!frontendEntry) continue; // approved but declares no frontend — nothing to bundle

    validateFrontendEntry(root, frontendEntry);

    const source = classifySource(root, repoRoot, policy.builtinNames, name);
    const installedHash = doHash(root);
    if (source === "external" && entry.approved_hash_sha256 !== installedHash) {
      throw new Error(`vonzio-plugins: "${name}" installed hash does not match the approved hash — re-approve with the CLI before building.`);
    }
    out.push({ name, source, hash: installedHash, specifier: `${name}/frontend` });
  }
  return out;
}

export interface VonzioPluginsOptions {
  operatorPolicyPath?: string;
}

/** The Vite plugin. Add to packages/dashboard/vite.config.ts plugins[]. */
export default function vonzioPlugins(_options: VonzioPluginsOptions = {}): Plugin {
  let approved: ApprovedFrontend[] = [];
  let policyPath: string | null = null;
  let policyHash: string | null = null;
  let outDir = "dist";
  let root = process.cwd();
  let isBuild = false;

  return {
    name: "vonzio-plugins",

    configResolved(config) {
      isBuild = config.command === "build";
      outDir = config.build.outDir;
      root = config.root;
      const repoRoot = findRepoRoot();
      const policy = loadFrontendPolicy(repoRoot);
      approved = computeApprovedFrontends({ policy, repoRoot });
      policyPath = policy.operatorPath;
      policyHash = policyPath ? createHash("sha256").update(readFileSync(policyPath)).digest("hex") : null;
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      const imports = approved.map((p, i) => `import register${i} from ${JSON.stringify(p.specifier)};`).join("\n");
      const entries = approved.map((p, i) => `  { name: ${JSON.stringify(p.name)}, register: register${i} },`).join("\n");
      return `${imports}\nexport const pluginFrontends = [\n${entries}\n];\n`;
    },

    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Stamp the nonce placeholder only for the production BUILD — in dev the
        // dashboard is served by Vite (HMR, no core-server CSP). ctx.server is
        // present only in the dev server.
        if (!isBuild || ctx.server) return html;
        return html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${NONCE_PLACEHOLDER}"`);
      },
    },

    writeBundle() {
      const json: PluginsJson = {
        plugins: approved.map((p) => ({ name: p.name, source: p.source, hash: p.hash })),
        policyPath,
        policyHash,
      };
      writeFileSync(path.resolve(root, outDir, ".plugins.json"), JSON.stringify(json, null, 2) + "\n");
    },
  };
}

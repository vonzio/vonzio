import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashPackageDir as viteHash,
  computeApprovedFrontends,
  type LoadedFrontendPolicy,
} from "./vite-vonzio-plugins.js";
import { hashPackageDir as sharedHash } from "@vonzio/plugin-api/policy";
import type { PolicyEntry } from "@vonzio/plugin-api";

describe("hashPackageDir drift guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vonzio-vp-"));
    writeFileSync(path.join(dir, "a.ts"), "x\n");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "b.ts"), "y\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the Vite plugin's inlined hash is byte-identical to @vonzio/plugin-api/policy", () => {
    // If this ever diverges, the dashboard bundle hash won't match the runtime
    // parity check and every prod boot would fail. Keep them in lockstep.
    expect(viteHash(dir)).toBe(sharedHash(dir));
  });
});

describe("computeApprovedFrontends", () => {
  let root: string;
  const pkgDirs: Record<string, string> = {};

  function makePkg(name: string, opts: { frontendEntry?: string; builtin?: boolean } = {}): string {
    // Built-ins live under <repoRoot>/packages/ (classifySource → builtin);
    // externals live under <repoRoot>/node_modules/<name> (the containment the
    // Vite plugin now enforces for externals).
    const dir = opts.builtin
      ? path.join(root, "packages", name.replace(/[@/]/g, "_"))
      : path.join(root, "node_modules", ...name.split("/"));
    const vonzio: Record<string, unknown> = { apiVersion: "1.0", backendEntry: "./index.ts", capabilities: [] };
    mkdirSync(dir, { recursive: true });
    if (opts.frontendEntry) {
      vonzio.frontendEntry = opts.frontendEntry;
      mkdirSync(path.join(dir, path.dirname(opts.frontendEntry)), { recursive: true });
      writeFileSync(path.join(dir, opts.frontendEntry), "export default () => {};\n");
    }
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", vonzio }));
    pkgDirs[name] = dir;
    return dir;
  }

  function policy(entries: Record<string, Partial<PolicyEntry>>, builtins: string[] = []): LoadedFrontendPolicy {
    const map = new Map<string, PolicyEntry>();
    for (const [name, e] of Object.entries(entries)) {
      map.set(name, {
        version: "1.0.0",
        approved_hash_sha256: e.approved_hash_sha256 ?? "",
        approved_capabilities: [],
        approved_outbound_hosts: [],
        ...e,
      });
    }
    return { entries: map, builtinNames: new Set(builtins), operatorPath: null };
  }

  // Mirror the production resolver, which realpaths the package root.
  const resolveRoot = (_repo: string, name: string) => (pkgDirs[name] ? realpathSync(pkgDirs[name]) : null);

  beforeEach(() => {
    // realpath so classifySource (which compares against realpath'd package
    // roots) sees a consistent base — tmpdir is /var -> /private/var on macOS.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "vonzio-repo-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const d of Object.values(pkgDirs)) rmSync(d, { recursive: true, force: true });
    for (const k of Object.keys(pkgDirs)) delete pkgDirs[k];
  });

  it("bundles an approved built-in (frontend declared, hash skipped)", () => {
    makePkg("@v/slack", { frontendEntry: "./src/frontend.tsx", builtin: true });
    const out = computeApprovedFrontends({
      policy: policy({ "@v/slack": { approved_frontend: true, approved_hash_sha256: "ignored-for-builtin" } }, ["@v/slack"]),
      repoRoot: root,
      resolveRoot,
    });
    expect(out.map((p) => p.name)).toEqual(["@v/slack"]);
    expect(out[0].source).toBe("builtin");
    expect(out[0].specifier).toBe("@v/slack/frontend");
  });

  it("bundles an approved external only when its hash matches", () => {
    const dir = makePkg("@v/ext", { frontendEntry: "./src/frontend.tsx" });
    const realHash = sharedHash(dir);
    const ok = computeApprovedFrontends({
      policy: policy({ "@v/ext": { approved_frontend: true, approved_hash_sha256: realHash } }),
      repoRoot: root,
      resolveRoot,
    });
    expect(ok.map((p) => p.name)).toEqual(["@v/ext"]);
    expect(ok[0].source).toBe("external");

    expect(() =>
      computeApprovedFrontends({
        policy: policy({ "@v/ext": { approved_frontend: true, approved_hash_sha256: "WRONG" } }),
        repoRoot: root,
        resolveRoot,
      }),
    ).toThrow(/hash does not match/);
  });

  it("refuses an approved plugin that isn't installed", () => {
    expect(() =>
      computeApprovedFrontends({
        policy: policy({ "@v/missing": { approved_frontend: true } }),
        repoRoot: root,
        resolveRoot,
      }),
    ).toThrow(/not installed/);
  });

  it("skips an approved plugin that declares no frontend", () => {
    makePkg("@v/headless"); // no frontendEntry
    const out = computeApprovedFrontends({
      policy: policy({ "@v/headless": { approved_frontend: true } }),
      repoRoot: root,
      resolveRoot,
    });
    expect(out).toEqual([]);
  });

  it("ignores plugins not approved for frontend", () => {
    makePkg("@v/notapproved", { frontendEntry: "./src/frontend.tsx" });
    const out = computeApprovedFrontends({
      policy: policy({ "@v/notapproved": { approved_frontend: false } }),
      repoRoot: root,
      resolveRoot,
    });
    expect(out).toEqual([]);
  });

  it("rejects a crafted policy-key name (path traversal)", () => {
    expect(() =>
      computeApprovedFrontends({
        policy: policy({ "../../../evil": { approved_frontend: true } }),
        repoRoot: root,
        resolveRoot,
      }),
    ).toThrow(/invalid plugin name/);
  });

  it("refuses an external whose real path escapes node_modules/<name> (npm-link)", () => {
    // Resolve the external to a dir OUTSIDE node_modules (simulating a symlink
    // / npm link). Containment must refuse it.
    const linked = makePkg("@v/linked", { frontendEntry: "./src/frontend.tsx" });
    const outside = mkdtempSync(path.join(tmpdir(), "vonzio-linked-"));
    // copy the package.json + frontend so the dir is a valid package
    mkdirSync(path.join(outside, "src"), { recursive: true });
    writeFileSync(path.join(outside, "package.json"), readFileSync(path.join(linked, "package.json")));
    writeFileSync(path.join(outside, "src", "frontend.tsx"), "export default () => {};\n");
    expect(() =>
      computeApprovedFrontends({
        policy: policy({ "@v/linked": { approved_frontend: true, approved_hash_sha256: "x" } }),
        repoRoot: root,
        resolveRoot: () => realpathSync(outside),
      }),
    ).toThrow(/not within node_modules/);
    rmSync(outside, { recursive: true, force: true });
  });
});

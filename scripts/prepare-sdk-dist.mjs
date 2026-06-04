#!/usr/bin/env node
// Build a publishable npm package into ./dist for a vonzio SDK package
// (@vonzio/shared, @vonzio/plugin-api). Run from the package directory
// (npm sets cwd): `node ../../scripts/prepare-sdk-dist.mjs`.
//
// Why "publish from dist": the source package.json keeps `private: true` +
// `exports` pointing at `./src/*.ts` so the monorepo's no-build dev flow
// (tsx/Vite/vitest resolving TS source via the workspace) is untouched. This
// script emits a SEPARATE `dist/package.json` (no private, exports → built
// `./*.js` + `./*.d.ts`, workspace `*` deps pinned to `^version`) so the dist
// directory is a self-contained, publishable package. CI does `cd dist && npm
// publish`. See docs/PLUGIN_LOADER_SPEC.md §16 follow-ups / PR-A.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

const pkgDir = process.cwd();
const repoRoot = path.resolve(pkgDir, "..", "..");
const src = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

// 1. Clean + compile to ./dist via the test-excluding build config.
rmSync(path.join(pkgDir, "dist"), { recursive: true, force: true });
execFileSync("npx", ["tsc", "--project", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });

// 2. Rewrite an `./src/x.ts` export target to its built dist-relative path.
const toDist = (srcPath, kind) => {
  const base = srcPath.replace(/^\.\/src\//, "./").replace(/\.tsx?$/, "");
  return kind === "types" ? `${base}.d.ts` : `${base}.js`;
};
const rewriteExports = (exp) => {
  const out = {};
  for (const [key, val] of Object.entries(exp)) {
    out[key] = { types: toDist(val.types, "types"), import: toDist(val.import, "import") };
  }
  return out;
};

// 3. Pin workspace ("*") @vonzio deps to "^<published version>".
const pinDeps = (deps) => {
  if (!deps) return undefined;
  const out = {};
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith("@vonzio/") && range === "*") {
      const unscoped = name.slice("@vonzio/".length);
      const sibling = JSON.parse(readFileSync(path.join(repoRoot, "packages", unscoped, "package.json"), "utf8"));
      out[name] = `^${sibling.version}`;
    } else {
      out[name] = range;
    }
  }
  return out;
};

// 4. Generate the publishable dist/package.json. Spread the source manifest so
// any field a future maintainer adds (engines, sideEffects, keywords, peerDeps,
// …) carries through automatically, then strip the dev-only bits and override
// the entry points + deps for the built layout. The `files` allowlist keeps the
// emitted source/declaration maps — which reference the unpublished ./src tree —
// out of the tarball (npm always ships package.json + README + LICENSE anyway).
const pinnedDeps = pinDeps(src.dependencies);
const { private: _private, scripts: _scripts, devDependencies: _devDeps, ...rest } = src;
const distPkg = {
  ...rest,
  main: toDist(src.main, "import"),
  types: toDist(src.types, "types"),
  exports: rewriteExports(src.exports),
  ...(pinnedDeps ? { dependencies: pinnedDeps } : {}),
  files: ["**/*.js", "**/*.d.ts"],
  publishConfig: { access: "public" },
};
writeFileSync(path.join(pkgDir, "dist", "package.json"), JSON.stringify(distPkg, null, 2) + "\n");

// 5. Ship LICENSE + a minimal README in the tarball.
const license = path.join(repoRoot, "LICENSE");
if (existsSync(license)) copyFileSync(license, path.join(pkgDir, "dist", "LICENSE"));
writeFileSync(
  path.join(pkgDir, "dist", "README.md"),
  `# ${src.name}\n\n${src.description ?? ""}\n\nPart of [vonzio](https://vonzio.com). See the external plugin SDK guide: https://github.com/vonzio/vonzio/blob/main/docs/PLUGIN_SDK.md\n`,
);

console.log(`prepared ${src.name}@${src.version} in ${path.relative(repoRoot, path.join(pkgDir, "dist"))}/`);

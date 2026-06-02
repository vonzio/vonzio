import { PLUGIN_API_VERSION } from "./index.js";

/**
 * Throw if the plugin's declared plugin-api version isn't compatible
 * with core's. Compatibility is major-version-based: a plugin built
 * against `0.x` works on core `0.x` (additive minors). A plugin built
 * against `1.x` does not load on core `0.x` (and vice versa).
 *
 * Called by the loader before invoking `init()` on each plugin.
 */
export function assertApiCompatible(
  pluginApiVersion: string,
  coreApiVersion: string = PLUGIN_API_VERSION,
): void {
  const pluginMajor = parseMajor(pluginApiVersion);
  const coreMajor = parseMajor(coreApiVersion);
  if (pluginMajor === null) {
    throw new Error(
      `Plugin declared invalid apiVersion: ${JSON.stringify(pluginApiVersion)}. Expected semver like "0.1.0".`,
    );
  }
  if (coreMajor === null) {
    // Should never trip in practice -- core's version is a literal in
    // index.ts. Bail loudly if it somehow does.
    throw new Error(`Internal: core apiVersion is malformed: ${coreApiVersion}`);
  }
  if (pluginMajor > coreMajor) {
    throw new Error(
      `Plugin requires plugin-api ^${pluginMajor}.0.0 but core ships ${coreApiVersion}. ` +
        `Upgrade vonzio core to v${pluginMajor}.x, or use a plugin compatible with plugin-api ^${coreMajor}.0.0.`,
    );
  }
  if (pluginMajor < coreMajor) {
    throw new Error(
      `Plugin built against plugin-api ^${pluginMajor}.0.0 is incompatible with core's plugin-api ${coreApiVersion}. ` +
        `Upgrade the plugin to a version targeting plugin-api ^${coreMajor}.0.0.`,
    );
  }
  // Same major: compatible. Minor differences are additive by design.
}

function parseMajor(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

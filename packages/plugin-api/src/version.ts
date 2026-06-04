import { PLUGIN_API_VERSION } from "./index.js";

/**
 * Throw if the plugin's declared plugin-api version isn't compatible with
 * core's. As of the external-loader contract (PLUGIN_API_VERSION 1.0.0)
 * compatibility is BOTH major-equal AND minor-not-ahead:
 *
 *   plugin.major === core.major   (a different major is breaking either way)
 *   plugin.minor <= core.minor    (a plugin built against a newer minor may
 *                                  rely on a surface this core doesn't ship)
 *
 * The minor check catches forward-incompatibility: capabilities are added in
 * minor bumps (§5), so a plugin targeting a newer minor than core can declare
 * a capability core doesn't understand. Same-major / not-ahead-minor is the
 * compatible window. Called by the loader before importing each plugin.
 */
export function assertApiCompatible(
  pluginApiVersion: string,
  coreApiVersion: string = PLUGIN_API_VERSION,
): void {
  const plugin = parseVersion(pluginApiVersion);
  const core = parseVersion(coreApiVersion);
  if (plugin === null) {
    throw new Error(
      `Plugin declared invalid apiVersion: ${JSON.stringify(pluginApiVersion)}. Expected semver like "1.0".`,
    );
  }
  if (core === null) {
    // Should never trip in practice -- core's version is a literal in
    // index.ts. Bail loudly if it somehow does.
    throw new Error(`Internal: core apiVersion is malformed: ${coreApiVersion}`);
  }
  if (plugin.major > core.major) {
    throw new Error(
      `Plugin requires plugin-api ^${plugin.major}.0.0 but core ships ${coreApiVersion}. ` +
        `Upgrade vonzio core to v${plugin.major}.x, or use a plugin compatible with plugin-api ^${core.major}.0.0.`,
    );
  }
  if (plugin.major < core.major) {
    throw new Error(
      `Plugin built against plugin-api ^${plugin.major}.0.0 is incompatible with core's plugin-api ${coreApiVersion}. ` +
        `Upgrade the plugin to a version targeting plugin-api ^${core.major}.0.0.`,
    );
  }
  if (plugin.minor > core.minor) {
    throw new Error(
      `Plugin targets plugin-api ${pluginApiVersion} but core ships ${coreApiVersion} ` +
        `(plugin minor ${plugin.minor} > core minor ${core.minor}). ` +
        `A newer-minor plugin may use a capability this core does not provide. ` +
        `Upgrade vonzio core, or use a plugin targeting plugin-api <=${core.major}.${core.minor}.`,
    );
  }
  // major equal AND plugin.minor <= core.minor: compatible.
}

/** Parse "MAJOR.MINOR(.PATCH)" into numeric parts; null if malformed. */
function parseVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

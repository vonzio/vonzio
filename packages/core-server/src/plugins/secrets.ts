// The `ctx.secrets` surface (gated by `secrets.mtls`). v1 resolves an
// operator-provisioned mTLS client cert/key — declared by logical name in the
// plugin manifest, mapped to host file paths in operator policy — into an
// OPAQUE reference the plugin passes to `ctx.http.fetch({ mtls })`. The plugin
// never reads the cert/key bytes through this surface: the bytes are loaded
// server-side (by the loader, into the HTTP surface's closure) and the ref
// carries only the logical name. See docs/PLUGIN_LOADER_SPEC.md §5, §10.

import { CapabilityViolationError, type MtlsRef, type PluginSecrets } from "@vonzio/plugin-api";

export interface MakePluginSecretsOpts {
  pluginName: string;
  /** Logical mtls names the plugin declared AND the operator provisioned
   *  (manifest.mtlsSecrets ∩ policy.mtls_secrets). Resolving any other name
   *  throws — defense in depth even though the loader already cross-checked. */
  declaredNames: ReadonlySet<string>;
  /** Audit hook fired once per successful resolution. */
  onResolve?: (info: { plugin: string; name: string }) => void;
}

export function makePluginSecrets(opts: MakePluginSecretsOpts): PluginSecrets {
  const { pluginName, declaredNames } = opts;
  return {
    mtls(name: string): MtlsRef {
      if (!declaredNames.has(name)) {
        // Same vocabulary as the membrane: an undeclared name is a capability
        // violation (audited by the caller's onViolation path via the throw).
        throw new CapabilityViolationError({
          plugin: pluginName,
          capability: "secrets.mtls",
          key: `secrets.mtls(${name})`,
        });
      }
      opts.onResolve?.({ plugin: pluginName, name });
      // Frozen so a plugin can't mutate the brand/name after the fact.
      return Object.freeze({ __vonzioMtls: true as const, name });
    },
  };
}

/**
 * Information the orchestrator needs to bring up a tunnel sidecar.
 * The encrypted config is opaque to OSS — decryption happens in the
 * sidecar launch path with the deployment's ENCRYPTION_KEY.
 */
export interface TunnelInfo {
  id: string;
  name: string;
  type: string;
  encryptedConfig: string;
  /**
   * Docker image to launch as the sidecar. SaaS deployments pin this
   * (e.g. "vonzio/wireguard-sidecar:0.1.0"); OSS never sees it because
   * the default provider returns null.
   */
  sidecarImage: string;
}

/**
 * Resolves the active VPN tunnel for an agent launch, if any. OSS
 * deployments use the noop default which always returns null —
 * tunnels are a SaaS feature, but the seam keeps the orchestrator
 * indifferent.
 */
export interface VpnTunnelProvider {
  resolveActiveTunnel(
    userId: string,
    profileId: string,
  ): Promise<TunnelInfo | null>;
}

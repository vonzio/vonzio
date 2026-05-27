/**
 * Information the orchestrator needs to bring up a tunnel sidecar.
 * The encrypted config is opaque to OSS — decryption happens in the
 * sidecar launch path with the deployment's ENCRYPTION_KEY.
 */
export interface TunnelInfo {
  id: string;
  name: string;
  type: string;
  /**
   * Encrypted tunnel config. Required for "wireguard" / "openvpn" where
   * the sidecar needs a config file at boot. Empty/omitted for
   * "tailscale" — that protocol authenticates with an auth key (carried
   * in `authBlobEncrypted`) and discovers the network via the tailnet
   * coordination server, no static config.
   */
  encryptedConfig?: string;
  /**
   * Docker image to launch as the sidecar. SaaS deployments pin this
   * (e.g. "vonzio/wireguard-sidecar:0.1.0"); OSS never sees it because
   * the default provider returns null.
   */
  sidecarImage: string;
  /**
   * Optional second encrypted blob carried by protocols that need
   * additional credentials beyond the main config (e.g. OpenVPN's
   * username/password for `--auth-user-pass`). WireGuard ignores it.
   */
  authBlobEncrypted?: string;
  /**
   * When true, the sidecar applies iptables rules so attached agents
   * can ONLY reach hosts via the tunnel — public-internet egress is
   * blocked. Compliance-grade isolation.
   */
  egressLockdown?: boolean;
  /**
   * Routing mode. When true, the sidecar rewrites the tunnel config
   * so 0.0.0.0/0 routes via the tunnel — public-internet traffic NATs
   * out the VPN server's egress IP. Requires the VPN server to be
   * configured for forwarding. When true, egressLockdown is redundant
   * (only the tunnel has a usable route).
   */
  fullTunnel?: boolean;
  /**
   * Monotonic version tag (the row's updated_at). Orchestrator
   * compares this against the cached sidecar's stored version; on
   * change, the cached sidecar is torn down so the next agent dispatch
   * gets a fresh one with the new config (e.g. lockdown toggled,
   * config rotated). Existing attached agents finish on the stale
   * sidecar — no force-disconnect.
   */
  version: string;
}

/**
 * Resolves the active VPN tunnel for an agent launch, if any. OSS
 * deployments use the noop default which always returns null —
 * tunnels are a SaaS feature, but the seam keeps the orchestrator
 * indifferent.
 */
export interface VpnTunnelProvider {
  /**
   * Resolves the tunnel for an agent launch.
   *
   * @param workspaceId  Optional. When supplied, providers may consult
   *   a per-workspace override (the workspace is pinned to a specific
   *   tunnel) before falling back to profile-based matching. The
   *   parameter is opaque to the seam and ignored by providers that
   *   don't support per-workspace pinning (e.g. the OSS noop).
   */
  resolveActiveTunnel(
    userId: string,
    profileId: string,
    workspaceId?: string,
  ): Promise<TunnelInfo | null>;
  /**
   * Best-effort event recorder for tunnel lifecycle observability —
   * sidecar_up, sidecar_down, etc. cp-server's impl persists these to
   * the audit table and maintains an in-memory active-session counter
   * the list endpoint exposes. OSS default may noop.
   */
  recordEvent?(
    tunnelId: string,
    event: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
}

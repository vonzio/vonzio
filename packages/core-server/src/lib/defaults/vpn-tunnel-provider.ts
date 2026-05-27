import type { TunnelInfo, VpnTunnelProvider } from "@vonzio/shared";

export class NoopVpnTunnelProvider implements VpnTunnelProvider {
  async resolveActiveTunnel(
    _userId: string,
    _profileId: string,
  ): Promise<TunnelInfo | null> {
    return null;
  }
  async recordEvent(
    _tunnelId: string,
    _event: string,
    _details?: Record<string, unknown>,
  ): Promise<void> {
    // OSS noop — there are no tunnels to observe.
  }
}

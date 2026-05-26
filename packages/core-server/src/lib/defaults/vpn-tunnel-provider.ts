import type { TunnelInfo, VpnTunnelProvider } from "@vonzio/shared";

export class NoopVpnTunnelProvider implements VpnTunnelProvider {
  async resolveActiveTunnel(
    _userId: string,
    _profileId: string,
  ): Promise<TunnelInfo | null> {
    return null;
  }
}

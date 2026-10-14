import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_104_1_0 = VersionInfo.of({
  version: '1.104.1:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.102.4 to v1.104.1.\n\nContainer image: This version contains no changes except for library updates.\n\n1.104.1:\n- [changed] Go is updated to version 1.27.\n- [changed] WireGuard packet buffering uses less memory while waiting for peer handshakes.\n- [changed] WireGuard packet queue depth scales with CPU core count, reducing peak memory usage under heavy traffic.\n- [new] Client-side netmap caching improves start up speed and connectivity when the Tailscale control plane is unreachable.\n- [changed] WireGuard allocates a single packet buffer for batched I/O, improving throughput and reducing memory usage.\n- [fixed] An issue that could prevent traffic over IPv6 link-local addresses from flowing through direct and Tailscale Peer Relay connections is resolved.\n- [fixed] An issue preventing Linux desktop detection from working on Wayland environments is resolved.\n\n1.102.5:\n- [fixed] The client no longer stops tailscaled when it falls behind on status updates and the connection is closed, which was common on large tailnets. It reconnects instead, and exits only if it cannot reconnect within one minute.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_4_0 = VersionInfo.of({
  version: '1.98.4:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.96.5 to v1.98.4. ' +
      'Highlights across the v1.98 series: ' +
      'fixed a deadlock when processing peer changes while disconnecting from the control server (v1.98.4); ' +
      'fixed MagicDNS not resolving tailnet hostnames after a network change (v1.98.2); ' +
      'Go runtime updated to 1.26.3 (v1.98.2); ' +
      'Linux IP forwarding for subnet routers and exit nodes is now surfaced as a health check (v1.98.1); ' +
      'iOS devices can now act as exit nodes (v1.98.1); ' +
      'expired preferred peer addresses are cleared faster, reducing failover time (v1.98.1).',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

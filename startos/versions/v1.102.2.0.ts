import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_102_2_0 = VersionInfo.of({
  version: '1.102.2:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.98.10 to v1.102.2. ' +
      'Highlights across the v1.102.x client line: node additions and removals ' +
      'now process in constant time, significantly reducing CPU usage on large ' +
      'tailnets; Tailscale Funnel domains use TLS-ALPN-01 for faster HTTPS ' +
      'certificate renewals, and TLS certificates on idle servers now ' +
      'proactively auto-renew; a memory leak after a failed WireGuard handshake ' +
      'and a UDP GSO performance regression on Linux 7.0.x through 7.1.4 are ' +
      'resolved. v1.102.2 fixes a regression introduced in v1.102.1 where ' +
      'incoming Tailscale Funnel connections would fail. The container image ' +
      'itself carries no functional changes over v1.102.1 beyond library ' +
      'updates.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

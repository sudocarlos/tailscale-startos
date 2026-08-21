import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_102_3_0 = VersionInfo.of({
  version: '1.102.3:0',
  releaseNotes: {
    // TODO: Replace with real release notes from https://tailscale.com/changelog#client
    en_US:
      'Tailscale updated from v1.102.2 to v1.102.3.\n\n1.102.3:\n- [changed] Go is updated to version 1.26.6.\n- [fixed] Tailscale refuses host-scoped IPv4 destinations at every point that acts on an unmapped 4via6 address. This fix addresses a security vulnerability described in TS-2026-011.\n- [fixed] When MagicDNS is disabled, unqualified hostnames are correctly forwarded to the configured nameservers.\n- [fixed] Resolved an issue where nodes with Tailnet Lock enabled on large tailnets would experience startup failures.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

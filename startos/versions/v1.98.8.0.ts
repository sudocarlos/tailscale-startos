import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_8_0 = VersionInfo.of({
  version: '1.98.8:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.98.4 to v1.98.8. ' +
      'v1.98.5 only changed Apple-platform builds (not relevant). ' +
      'v1.98.6 and v1.98.7 were release candidates (skipped). ' +
      'Highlights in v1.98.8: ' +
      'fixed connectivity disruptions when the OS wakes from sleep (wireguard-go); ' +
      'fixed excessive handshake initiation retries (wireguard-go); ' +
      'fixed connection leaks in Tailscale SSH Session Recording.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

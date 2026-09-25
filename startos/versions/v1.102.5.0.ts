import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_102_5_0 = VersionInfo.of({
  version: '1.102.5:0',
  releaseNotes: {
    // TODO: Replace with real release notes from https://tailscale.com/changelog#client
    en_US: 'Tailscale updated to v1.102.5.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

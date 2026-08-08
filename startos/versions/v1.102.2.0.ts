import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_102_2_0 = VersionInfo.of({
  version: '1.102.2:0',
  releaseNotes: {
    // TODO: Replace with real release notes from https://tailscale.com/changelog#client
    en_US: 'Tailscale updated to v1.102.2.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

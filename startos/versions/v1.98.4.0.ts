import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_4_0 = VersionInfo.of({
  version: '1.98.4:0',
  releaseNotes: {
    en_US: 'Updated to Tailscale v1.98.4.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

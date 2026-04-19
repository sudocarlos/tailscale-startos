import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_96_5_0 = VersionInfo.of({
  version: '1.96.5:0',
  releaseNotes: {
    en_US: 'Updated to Tailscale v1.96.5. Migrated image source to ghcr.io.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

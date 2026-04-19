import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_96_4_0 = VersionInfo.of({
  version: '1.96.4:0',
  releaseNotes: {
    en_US: 'Initial release of Tailscale on StartOS',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

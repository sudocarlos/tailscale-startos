import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_96_5_2 = VersionInfo.of({
  version: '1.96.5:2',
  releaseNotes: {
    en_US:
      'URL plugin integration replacing Manage Serves and View Serves actions; StarOS self-target support; custom port selection for Add Serve.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

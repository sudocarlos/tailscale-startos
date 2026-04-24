import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_96_5_3 = VersionInfo.of({
  version: '1.96.5:3',
  releaseNotes: {
    en_US:
      'Add Set Machine Name action with critical first-run task prompt; add Get Started - Login action for headless auth-key authentication; security: bump fast-xml-parser to >=5.7.0.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

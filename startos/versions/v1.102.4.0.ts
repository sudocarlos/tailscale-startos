import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_102_4_0 = VersionInfo.of({
  version: '1.102.4:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.102.3 to v1.102.4.\n\n1.102.4:\n- [fixed] Resolved an issue that could cause a loss in connectivity when a netmap update occurs near the time of reauthentication.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

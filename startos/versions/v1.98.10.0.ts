import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_10_0 = VersionInfo.of({
  version: '1.98.10:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.98.9 to v1.98.10. ' +
      'This release addresses two security vulnerabilities in Tailscale SSH: ' +
      'Unix socket forwarding now respects symlink permissions (TS-2026-004), ' +
      'and additional checks now disallow UIDs and numeric-only usernames ' +
      '(TS-2026-006).',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

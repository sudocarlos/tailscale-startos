import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_9_0 = VersionInfo.of({
  version: '1.98.9:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.98.8 to v1.98.9. ' +
      'This release addresses several security vulnerabilities: Tailscale SSH now respects ' +
      'symlink permissions for Unix socket forwarding, Tailscale Serve restricts Unix socket ' +
      'proxy targets to the root user, Tailscale SSH rejects UIDs, numeric-only usernames, and ' +
      'usernames with leading dashes, nodes advertising Tailscale Services filter and reject ' +
      'packets from service IPs on ports they do not advertise, and Tailscale Serve/Funnel ' +
      'terminate path walks for non-absolute paths to prevent CPU core pinning. ' +
      'Also fixes an issue where changing a device tag via the CLI could log the user out.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

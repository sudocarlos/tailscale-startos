import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_98_9_1 = VersionInfo.of({
  version: '1.98.9:1',
  releaseNotes: {
    en_US:
      'Add Headscale (custom control server) support: set your Headscale URL ' +
      'with the new Control Server action and log in with a preauth key or a ' +
      'browser link — no restart needed, and your machine name and serves are ' +
      'preserved. With a custom control server, serves are plain http:// and ' +
      'Funnel is unavailable. Login, machine-name, and control-server changes ' +
      'now converge the daemon via a single `tailscale up` and re-apply serves ' +
      'automatically once logged in, so serves survive slow or interactive ' +
      'logins. Serve URL tiles no longer freeze: store/status files are ' +
      'written atomically, and URLs fall back to the tailnet IP when MagicDNS ' +
      'is unavailable. Requires StartOS 0.4.0-beta.10 or later.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

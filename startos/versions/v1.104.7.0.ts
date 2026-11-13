import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_104_7_0 = VersionInfo.of({
  version: '1.104.7:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.104.4 to v1.104.7.\n\nContainer image: This version contains no changes except for library updates.\n\n1.104.7:\n- [changed] Go is updated to Go 1.27.4, to explicitly resolve an issue in TLS ClientHello where some middleboxes break connections to the Tailscale control plane.\n\n1.104.6:\n- [fixed] A rare connectivity issue that affected dormant connections has been resolved.\n\n1.104.5:\n- [fixed] Connectivity stalls affecting Tailscale SSH, Tailscale Serve, and tsnet on lossy networks are resolved.\n- [fixed] Tailscale SSH sessions no longer disconnect when a check mode approval expires.\n- [fixed] An issue that could cause Tailscale SSH restarts to hang or background tasks to terminate is resolved.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

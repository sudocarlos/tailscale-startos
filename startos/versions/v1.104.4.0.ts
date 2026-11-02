import { VersionInfo } from '@start9labs/start-sdk'

export const v_1_104_4_0 = VersionInfo.of({
  version: '1.104.4:0',
  releaseNotes: {
    en_US:
      'Tailscale updated from v1.104.2 to v1.104.4.\n\n1.104.4:\n- [fixed] Tailscale SSH performs Unix socket forwarding on behalf of the authenticated user rather than as root , preventing authorized peers from using local and remote forwarding to reach root-only Unix sockets such as the Docker socket or the tailscaled local API. This fix addresses a security vulnerability described in TS-2026-014.\n- [fixed] Tailscale SSH bounds the memory used for session handling and releases it when the peer disconnects, preventing denial of service through unbounded memory growth in tailscaled from continuous window-change messages and environment variable appends. This fix addresses a security vulnerability described in TS-2026-015.\n- [fixed] Tailscale Serve restricts TCP forwards to Unix socket backends and revalidates backend paths on each connection, preventing access to privileged Unix sockets such as the tailscaled local API socket. This fix addresses a security vulnerability described in TS-2026-016.\n- [fixed] Tailscale Serve derives per-request capabilities from the request context rather than from a context shared across all HTTP/2 streams, preventing Tailscale-App-Capabilities values from one mount from being sent with requests for another. This fix addresses a security vulnerability described in TS-2026-017.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})

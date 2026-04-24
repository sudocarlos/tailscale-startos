import { z } from '@start9labs/start-sdk'
import { servesShape } from './fileModels/store.json'

const SOCKET = '/var/run/tailscale/tailscaled.sock'

/**
 * Applies Tailscale serve configuration using CLI commands.
 *
 * Resets all existing serves first, then adds each entry via
 * `tailscale serve --bg --https <port> <target>` for HTTP/HTTPS backends
 * or `tailscale serve --bg --tcp <port> <target>` for TCP passthrough.
 *
 * Entries with `hostId === ''` are legacy records that have not yet been
 * upgraded by the user (they still hold a reserved port).  They are skipped
 * here and in URL export; the user re-clicks "Add Serve" to self-heal them.
 *
 * Scheme mapping (upstream → tailscale serve target):
 *   'http' | 'ws'          → http://<host>:<port>              --https  (HTTP upstream)
 *   'https' | 'wss'        → https+insecure://<host>:<port>    --https  (HTTPS upstream, skip verify)
 *   'ssh' | 'dns' | null   → tcp://<host>:<port>               --tcp    (raw TCP passthrough)
 *   <anything else>        → tcp://<host>:<port>               --tcp    (unknown → safe default)
 *
 * The --https <tailnetPort> flag controls TLS on the tailnet-facing side and
 * is independent of the upstream target scheme.
 */
export async function applyServicesConfig(
  sub: {
    exec: (
      cmd: string[],
    ) => Promise<{ exitCode: number | null; stderr: Buffer | string }>
  },
  store: z.infer<typeof servesShape>,
): Promise<void> {
  // Reset all existing serves first
  const resetResult = await sub.exec([
    'tailscale',
    '--socket=' + SOCKET,
    'serve',
    'reset',
  ])
  if (resetResult.exitCode !== 0) {
    throw new Error(
      `tailscale serve reset failed: ${resetResult.stderr.toString()}`,
    )
  }

  let count = 0
  for (const [packageId, ifaces] of Object.entries(store)) {
    for (const [interfaceId, entry] of Object.entries(ifaces)) {
      // Skip legacy entries — they have no cached metadata yet
      if (entry.hostId === '') {
        console.info(
          `[serves] skipping legacy entry ${packageId}/${interfaceId} (re-click Add Serve to upgrade)`,
        )
        continue
      }

      const { port, scheme, internalPort } = entry
      // StarOS UI is reachable at 'startos'; other services use '<packageId>.startos'
      const host = packageId === 'startos' ? 'startos' : `${packageId}.startos`

      let target: string
      let isHttpProxy: boolean

      if (scheme === 'http' || scheme === 'ws') {
        target = `http://${host}:${internalPort}`
        isHttpProxy = true
      } else if (scheme === 'https' || scheme === 'wss') {
        target = `https+insecure://${host}:${internalPort}`
        isHttpProxy = true
      } else {
        // TCP passthrough: null, 'ssh', 'dns', or any unrecognised scheme
        target = `tcp://${host}:${internalPort}`
        isHttpProxy = false
      }

      console.info(
        `[serves] ${packageId}/${interfaceId}: scheme=${scheme} → ${isHttpProxy ? '--https' : '--tcp'} ${port} ${target}`,
      )

      const cmd = isHttpProxy
        ? [
            'tailscale',
            '--socket=' + SOCKET,
            'serve',
            '--bg',
            '--https',
            String(port),
            target,
          ]
        : [
            'tailscale',
            '--socket=' + SOCKET,
            'serve',
            '--bg',
            '--tcp',
            String(port),
            target,
          ]

      const result = await sub.exec(cmd)
      if (result.exitCode !== 0) {
        throw new Error(
          `tailscale serve failed for ${packageId}/${interfaceId}: ${result.stderr.toString()}`,
        )
      }
      count++
    }
  }

  console.info(`[serves] applied ${count} serve(s)`)
}

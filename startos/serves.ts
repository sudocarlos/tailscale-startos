import { z } from '@start9labs/start-sdk'
import { shape } from './fileModels/store.json'

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
 * Scheme mapping (all data is now cached in the store entry):
 *   packageId === 'startos'       → https+insecure://startos.startos:443  (http proxy)
 *   entry.scheme === 'http'       → https://<host>:<internalPort>          (http proxy)
 *   entry.scheme === 'https'      → https+insecure://<host>:<internalPort> (http proxy)
 *   entry.scheme === null         → tcp://<host>:<internalPort>            (tcp)
 */
export async function applyServicesConfig(
  sub: {
    exec: (
      cmd: string[],
    ) => Promise<{ exitCode: number | null; stderr: Buffer | string }>
  },
  store: z.infer<typeof shape>,
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
    // Skip StartOS self-target — not a supported serve target.
    if (packageId === 'startos') {
      console.info(
        `[serves] skipping startos self-target (not supported)`,
      )
      continue
    }

    for (const [interfaceId, entry] of Object.entries(ifaces)) {
      // Skip legacy entries — they have no cached metadata yet
      if (entry.hostId === '') {
        console.info(
          `[serves] skipping legacy entry ${packageId}/${interfaceId} (re-click Add Serve to upgrade)`,
        )
        continue
      }

      const { port, scheme, internalPort } = entry
      const host = `${packageId}.startos`

      let target: string
      let isHttpProxy: boolean

      if (scheme === 'http') {
        target = `https://${host}:${internalPort}`
        isHttpProxy = true
      } else if (scheme === 'https') {
        target = `https+insecure://${host}:${internalPort}`
        isHttpProxy = true
      } else {
        // TCP passthrough
        target = `tcp://${host}:${internalPort}`
        isHttpProxy = false
      }

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

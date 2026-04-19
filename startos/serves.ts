import { z } from '@start9labs/start-sdk'
import { shape } from './fileModels/store.json'
import { sdk } from './sdk'

const SOCKET = '/var/run/tailscale/tailscaled.sock'

/**
 * Applies Tailscale serve configuration using CLI commands.
 *
 * Resets all existing serves first, then adds each entry via
 * `tailscale serve --bg --https <port> <target>` for HTTP/HTTPS backends
 * or `tailscale serve --bg --tcp <port> <target>` for TCP.
 *
 * Scheme mapping:
 *   packageId === 'startos'  → https+insecure://startos.startos:443  (ssl)
 *   addressInfo.scheme === 'http'   → https://<host>:<internalPort>  (ssl)
 *   addressInfo.scheme === 'https'  → https+insecure://<host>:<internalPort>  (ssl)
 *   else                            → tcp://<host>:<internalPort>  (no ssl)
 */
export async function applyServicesConfig(
  sub: {
    exec: (
      cmd: string[],
    ) => Promise<{ exitCode: number | null; stderr: Buffer | string }>
  },
  store: z.infer<typeof shape>,
  effects: Parameters<typeof sdk.serviceInterface.get>[0],
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
    for (const [interfaceId, port] of Object.entries(ifaces)) {
      let target: string
      let isHttpProxy: boolean

      if (packageId === 'startos') {
        target = 'https+insecure://startos.startos:443'
        isHttpProxy = true
      } else {
        const host = `${packageId}.startos`
        const iface = await sdk.serviceInterface
          .get(effects, { id: interfaceId, packageId })
          .once()
        if (!iface?.addressInfo) {
          console.warn(
            `[serves] no addressInfo for ${packageId}/${interfaceId}, skipping`,
          )
          continue
        }
        const { scheme, internalPort } = iface.addressInfo
        if (scheme === 'http') {
          target = `https://${host}:${internalPort}`
          isHttpProxy = true
        } else if (scheme === 'https') {
          target = `https+insecure://${host}:${internalPort}`
          isHttpProxy = true
        } else {
          target = `tcp://${host}:${internalPort}`
          isHttpProxy = false
        }
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

import { sdk } from './sdk'
import { statusJson } from './fileModels/status.json'
import { storeJson } from './fileModels/store.json'
import { parseTailscaleIp, parseDnsName } from './utils'
import { startProxy, proxyKey } from './tcpProxy'

const UI_PORT = 8080
const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info('Starting Tailscale!')

  let servesRestored = false

  const mounts = sdk.Mounts.of().mountVolume({
    volumeId: 'tailscale',
    subpath: null,
    mountpoint: STATE_DIR,
    readonly: false,
  })

  const subcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'tailscale', sharedRun: true },
    mounts,
    'tailscale-sub',
  )

  return sdk.Daemons.of(effects)
    .addDaemon('tailscaled', {
      subcontainer,
      exec: {
        command: [
          'tailscaled',
          '--state=' + STATE_DIR + '/tailscaled.state',
          '--socket=' + SOCKET,
          '--tun=userspace-networking',
        ],
      },
      ready: {
        display: 'Tailscale Daemon',
        fn: async () => {
          const result = await subcontainer.exec([
            'tailscale',
            '--socket=' + SOCKET,
            'status',
            '--json',
          ])
          if (result.exitCode !== 0) {
            return {
              result: 'loading',
              message: 'Waiting for tailscaled to be ready...',
            }
          }
          // Persist IP and DNS name for use by actions
          try {
            const ipResult = await subcontainer.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'ip',
              '-4',
            ])
            if (ipResult.exitCode === 0) {
              const ip = parseTailscaleIp(ipResult.stdout.toString())
              const dnsName = parseDnsName(result.stdout.toString())
              await statusJson.write(effects, { ip, dnsName })
            }
          } catch (e) {
            console.error('Failed to persist tailscale status:', e)
          }

          // Restore tailscale serve configs from store on first ready
          if (!servesRestored) {
            servesRestored = true
            try {
              const store = (await storeJson.read().const(effects)) || {}
              for (const [packageId, ifaces] of Object.entries(store)) {
                for (const [interfaceId, port] of Object.entries(ifaces)) {
                  let host: string
                  let internalPort: number

                  if (packageId === 'startos') {
                    host = 'startos.startos'
                    internalPort = 80
                  } else {
                    host = `${packageId}.startos`
                    const iface = await sdk.serviceInterface
                      .get(effects, { id: interfaceId, packageId })
                      .once()
                    if (!iface?.addressInfo) continue
                    internalPort = iface.addressInfo.internalPort
                  }

                  // Start local TCP proxy: 127.0.0.1:<port> -> <host>:<internalPort>
                  const key = proxyKey(packageId, interfaceId)
                  try {
                    await startProxy(key, port, host, internalPort)
                  } catch (e) {
                    console.error(`Failed to start TCP proxy for ${key} on port ${port}:`, e)
                    continue
                  }

                  // Tell tailscale to serve TCP on this port -> localhost
                  const serveResult = await subcontainer.exec([
                    'tailscale',
                    '--socket=' + SOCKET,
                    'serve',
                    '--bg',
                    '--tcp=' + port,
                    `tcp://localhost:${port}`,
                  ])
                  if (serveResult.exitCode !== 0) {
                    console.error(`Failed to restore serve ${key} on port ${port}: ${serveResult.stderr.toString()}`)
                  } else {
                    console.info(`Restored serve ${key} on port ${port}`)
                  }
                }
              }
            } catch (e) {
              console.error('Failed to restore tailscale serves:', e)
            }
          }
          return {
            result: 'success',
            message: 'Tailscale daemon is running',
          }
        },
        gracePeriod: 10_000,
      },
      requires: [],
    })
    .addDaemon('tailscale-web', {
      subcontainer,
      exec: {
        command: [
          'tailscale',
          '--socket=' + SOCKET,
          'web',
          '--listen=0.0.0.0:' + UI_PORT,
        ],
      },
      ready: {
        display: 'Web Interface',
        fn: () =>
          sdk.healthCheck.checkPortListening(effects, UI_PORT, {
            successMessage: 'The web interface is ready',
            errorMessage: 'The web interface is not yet ready',
          }),
      },
      requires: ['tailscaled'],
    })
})

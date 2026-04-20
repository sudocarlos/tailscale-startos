import { sdk } from './sdk'
import { statusJson } from './fileModels/status.json'
import { storeJson } from './fileModels/store.json'
import { parseTailscaleIp, parseDnsName } from './utils'
import { applyServicesConfig } from './serves'

const UI_PORT = 8080
const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info('Starting Tailscale!')

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
              message: 'Waiting for tailscaled socket...',
            }
          }

          // Socket is responsive. Parse state for informational purposes and
          // to conditionally persist IP/DNS (only available once Running).
          // BackendState is "NoState" | "NeedsLogin" | "NeedsRoutineAuth" |
          // "Stopped" | "Starting" | "Running".
          // We do NOT block on Running here — the web UI must be reachable in
          // NeedsLogin so the user can authenticate on a fresh install.
          let statusData: { BackendState?: string; Self?: { DNSName?: string } }
          try {
            statusData = JSON.parse(result.stdout.toString().trim())
          } catch {
            statusData = {}
          }

          const backendState = statusData.BackendState ?? 'unknown'
          console.info(`[tailscaled] BackendState: ${backendState}`)

          // Persist IP and DNS name once the node is fully connected.
          if (backendState === 'Running') {
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
          }

          return {
            result: 'success',
            message: backendState === 'Running'
              ? 'Tailscale daemon is running'
              : `Tailscale daemon ready (${backendState})`,
          }
        },
        gracePeriod: 10_000,
      },
      requires: [],
    })
    .addOneshot('restore-serves', {
      subcontainer,
      exec: {
        fn: async () => {
          const store = (await storeJson.read().once()) || {}
          if (Object.keys(store).length > 0) {
            await applyServicesConfig(subcontainer, store)
          }
          return null
        },
      },
      requires: ['tailscaled'],
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
      requires: ['tailscaled', 'restore-serves'],
    })
})

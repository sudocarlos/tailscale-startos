import { sdk } from './sdk'
import { statusJson } from './fileModels/status.json'
import { storeJson } from './fileModels/store.json'
import { parseTailscaleIp, parseDnsName } from './utils'
import { applyServicesConfig } from './serves'
import { UI_PORT } from './constants'
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
          // Only write when the values actually change. This ready check is
          // polled continuously, and writing on every poll fires fs.watch
          // events on status.json. Each event causes the SDK's FileHelper
          // reactive `produce` loop to register a new abort listener on the
          // parent AbortSignal of any active `.const()` read (notably the
          // URL plugin's `setupExportedUrls` handler), eventually exceeding
          // Node's default MaxListeners=10 and emitting a spurious warning.
          // Skipping no-op writes eliminates the cause at the source.
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
                const prev = await statusJson.read().once()
                if (!prev || prev.ip !== ip || prev.dnsName !== dnsName) {
                  await statusJson.write(effects, { ip, dnsName })
                }
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
          // The tailscaled ready check returns as soon as the socket is alive
          // (BackendState may still be NoState/Starting) so the web UI can
          // unblock for fresh installs in NeedsLogin. Serve commands, however,
          // require a populated netMap — issuing `tailscale serve reset`
          // before the control-plane handshake completes fails with
          // "netMap is nil". Poll BackendState here so the restore is silent.
          const POLL_INTERVAL_MS = 500
          const POLL_TIMEOUT_MS = 30_000
          const deadline = Date.now() + POLL_TIMEOUT_MS

          while (Date.now() < deadline) {
            const r = await subcontainer.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'status',
              '--json',
            ])
            if (r.exitCode === 0) {
              let st: { BackendState?: string } = {}
              try {
                st = JSON.parse(r.stdout.toString())
              } catch {}
              const state = st.BackendState ?? ''
              if (state !== '' && state !== 'NoState' && state !== 'Starting') break
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          }

          if (Date.now() >= deadline) {
            console.warn(
              '[restore-serves] timed out waiting for tailscaled BackendState; proceeding anyway',
            )
          }

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

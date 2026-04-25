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

  const mounts = sdk.Mounts.of()
    .mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })
    .mountVolume({
      volumeId: 'taildrop',
      subpath: null,
      mountpoint: '/taildrop',
      readonly: false,
    })

  const subcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'tailscale', sharedRun: true },
    mounts,
    'tailscale-sub',
  )

  // Read any pending auth key saved by the Get Started action while the
  // container was stopped.  If present, it is applied via `tailscale login`
  // once the daemon socket is ready and BackendState is NeedsLogin.
  const initialStore = (await storeJson.read().once()) ?? {
    machineName: 'startos',
    hostnameSet: false,
    serves: {},
    authKey: null,
  }
  const pendingAuthKey = initialStore.authKey ?? null
  if (pendingAuthKey) {
    console.info('[main] Pending auth key found; will apply via tailscale login once daemon is ready.')
  } else {
    console.info('[main] No pending auth key in store.')
  }

  // Tracks whether we have already triggered the headless login for this
  // start cycle so the ready-check poll doesn't re-run it on every tick.
  let authKeyApplied = false

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

          // Apply a pending auth key as soon as the daemon reaches NeedsLogin.
          // Run only once per start cycle to avoid re-triggering on every poll.
          if (pendingAuthKey && !authKeyApplied && backendState === 'NeedsLogin') {
            authKeyApplied = true
            console.info('[main] Applying pending auth key via tailscale login...')
            try {
              const loginResult = await subcontainer.exec(
                ['sh', '-c', 'tailscale --socket="$TS_SOCKET" login --auth-key="$TS_AUTHKEY"'],
                { env: { TS_SOCKET: SOCKET, TS_AUTHKEY: pendingAuthKey } },
              )
              if (loginResult.exitCode !== 0) {
                console.error(
                  '[main] tailscale login failed: ' +
                    (loginResult.stderr?.toString().trim() ||
                      loginResult.stdout?.toString().trim() ||
                      `exit code ${loginResult.exitCode}`),
                )
              } else {
                console.info('[main] tailscale login succeeded.')
              }
            } catch (e) {
              console.error('[main] tailscale login threw:', e)
            }
          }

          if (backendState === 'Running') {
            // Persist IP and DNS name once the node is fully connected.
            // Only write when the values actually change. This ready check is
            // polled continuously, and writing on every poll fires fs.watch
            // events on status.json. Each event causes the SDK's FileHelper
            // reactive `produce` loop to register a new abort listener on the
            // parent AbortSignal of any active `.const()` read (notably the
            // URL plugin's `setupExportedUrls` handler), eventually exceeding
            // Node's default MaxListeners=10 and emitting a spurious warning.
            // Skipping no-op writes eliminates the cause at the source.
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

            // Clear any persisted auth key once the node is Running so it is not
            // re-applied on subsequent restarts (the identity is already persisted
            // in tailscaled.state). Check the current store value rather than
            // pendingAuthKey so keys written by the login action while the service
            // was already running are also cleared.
            try {
              const currentStore = (await storeJson.read().once()) ?? initialStore
              if (currentStore.authKey) {
                await storeJson.write(effects, { ...currentStore, authKey: null })
                console.info('[main] Auth key consumed and cleared from store.json.')
              }
            } catch (e) {
              console.error('[main] Failed to clear auth key from store.json:', e)
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
          // Serve commands require a populated netMap.  `tailscale serve reset`
          // fails with "netMap is nil" for any BackendState other than Running
          // (including NeedsLogin, which has no control-plane connection yet).
          // Poll until Running or timeout — if we never reach Running (e.g.
          // fresh install still waiting for auth), skip the restore entirely;
          // the serves will be reapplied on the next start once the node is
          // connected.
          const POLL_INTERVAL_MS = 500
          const POLL_TIMEOUT_MS = 10_000
          const deadline = Date.now() + POLL_TIMEOUT_MS

          let reachedRunning = false
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
              if (state === 'Running') {
                reachedRunning = true
                break
              }
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          }

          if (!reachedRunning) {
            console.info(
              '[restore-serves] BackendState never reached Running within timeout ' +
              '(node may need login); skipping serve restore — will retry on next start',
            )
            return null
          }

          const storeData = (await storeJson.read().once()) ?? {
            machineName: 'startos',
            hostnameSet: false,
            serves: {},
            authKey: null,
          }
          const serves = storeData.serves
          if (Object.keys(serves).length > 0) {
            await applyServicesConfig(subcontainer, serves)
          }
          return null
        },
      },
      requires: ['tailscaled'],
    })
    .addOneshot('set-hostname', {
      subcontainer,
      exec: {
        fn: async () => {
          // Always apply the user-chosen machine name via `tailscale set --hostname`
          // on every start.  The stored machineName is the source of truth; Tailscale
          // appends "-1"/"-N" automatically if the name conflicts with another node.
          const storeData = (await storeJson.read().once()) ?? {
            machineName: 'startos',
            hostnameSet: false,
            serves: {},
            authKey: null,
          }

          const name = storeData.machineName ?? 'startos'
          console.info(`[set-hostname] applying hostname: ${name}`)

          const r = await subcontainer.exec([
            'tailscale',
            '--socket=' + SOCKET,
            'set',
            '--hostname=' + name,
          ])

          if (r.exitCode !== 0) {
            throw new Error(
              `[set-hostname] tailscale set --hostname failed: ${r.stderr.toString()}`,
            )
          }

          console.info(`[set-hostname] hostname set to: ${name}`)
          return null
        },
      },
      requires: ['restore-serves'],
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
      requires: ['tailscaled', 'set-hostname'],
    })
    .addDaemon('taildrop-receive', {
      subcontainer,
      exec: {
        command: [
          'tailscale',
          '--socket=' + SOCKET,
          'file',
          'get',
          '--loop',
          '/taildrop',
        ],
      },
      ready: {
        display: 'Taildrop Receive',
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
              message: 'Waiting for Tailscale daemon...',
            }
          }
          let statusData: { BackendState?: string } = {}
          try {
            statusData = JSON.parse(result.stdout.toString().trim())
          } catch {}
          const backendState = statusData.BackendState ?? 'unknown'
          if (backendState !== 'Running') {
            return {
              result: 'loading',
              message: `Waiting for Tailscale to connect (${backendState})...`,
            }
          }
          return {
            result: 'success',
            message: 'Ready to receive files via Taildrop',
          }
        },
        gracePeriod: 10_000,
      },
      requires: ['set-hostname'],
    })
})

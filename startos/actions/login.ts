import { sdk } from '../sdk'
import { statusJson } from '../fileModels/status.json'
import { storeJson } from '../fileModels/store.json'
import { parseTailscaleIp } from '../utils'

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'
const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 30_000

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  authKey: Value.text({
    name: 'Auth Key (optional)',
    description:
      'Optionally provide a Tailscale auth key (tskey-auth-...) to authenticate headlessly. ' +
      'Leave blank and click Submit to skip — you can log in interactively via the web UI once the service is running. ' +
      'Generate an auth key at https://login.tailscale.com/admin/settings/keys',
    required: false,
    default: null,
    masked: true,
    placeholder: 'tskey-auth-... (leave blank to use the web UI)',
    warning: null,
  }),
})

export const getStarted = sdk.Action.withInput(
  // id
  'get-started',

  // metadata
  async () => ({
    name: 'Tailscale Login',
    description:
      'Provide a Tailscale auth key to login. ' +
      'Generate a new key at https://login.tailscale.com/admin/settings/keys',
    warning: 'Alternatively, go to Dashboard and click Open UI for interactive login.',
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill (none)
  async () => null,

  // execution
  async ({ effects, input }) => {
    const authKey = input.authKey?.trim() ?? ''

    if (!authKey) {
      // No key provided — user will authenticate via the web UI.
      console.info('[get-started] No auth key provided; user will log in via the web UI.')
      return
    }

    // Persist the auth key so it is available to tailscaled on next start via
    // TS_AUTH_KEY even if the container is currently stopped.
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
      authKey: null,
    }
    await storeJson.write(effects, { ...storeData, authKey })
    console.info('[get-started] Auth key saved to store.json for next container start.')

    // Attempt an immediate headless login if the container is already running.
    // This is best-effort: if the socket is unavailable (container stopped) the
    // error is caught and logged rather than surfaced to the user, because the
    // key will be applied automatically via TS_AUTH_KEY on the next start.
    try {
      const mounts = sdk.Mounts.of().mountVolume({
        volumeId: 'tailscale',
        subpath: null,
        mountpoint: STATE_DIR,
        readonly: false,
      })

      await sdk.SubContainer.withTemp(
        effects,
        { imageId: 'tailscale', sharedRun: true },
        mounts,
        'tailscale-get-started',
        async (sub) => {
          const loginResult = await sub.exec(
            [
              'sh',
              '-c',
              'tailscale --socket="$TS_SOCKET" login --auth-key="$TS_AUTHKEY"',
            ],
            { env: { TS_SOCKET: SOCKET, TS_AUTHKEY: authKey } },
          )
          if (loginResult.exitCode !== 0) {
            // The key was rejected by tailscale (not a socket/connectivity
            // error, which is caught by the outer catch).  Clear it from the
            // store so it is not retried on every subsequent restart.
            const errText =
              loginResult.stderr?.toString().trim() ||
              loginResult.stdout?.toString().trim() ||
              `exit code ${loginResult.exitCode}`
            // Don't clear the key for transient / socket-unavailable errors —
            // the outer catch handles those and we want to retry on next start.
            const isTransient =
              errText.includes('no such file') ||
              errText.includes('ENOENT') ||
              errText.includes('ECONNREFUSED') ||
              errText.includes('connect') ||
              errText.includes('socket')
            if (!isTransient) {
              try {
                const s = (await storeJson.read().once()) ?? { ...storeData, authKey }
                await storeJson.write(effects, { ...s, authKey: null })
              } catch {}
            }
            throw new Error('tailscale login failed: ' + errText)
          }

          const deadline = Date.now() + POLL_TIMEOUT_MS
          let lastState = 'unknown'

          while (Date.now() < deadline) {
            const statusResult = await sub.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'status',
              '--json',
            ])
            if (statusResult.exitCode === 0) {
              let statusData: {
                BackendState?: string
                Self?: { DNSName?: string }
              } = {}
              try {
                statusData = JSON.parse(statusResult.stdout.toString().trim())
              } catch {}

              lastState = statusData.BackendState ?? 'unknown'
              console.info(`[get-started] BackendState: ${lastState}`)

              if (lastState === 'Running') {
                const ipResult = await sub.exec([
                  'tailscale',
                  '--socket=' + SOCKET,
                  'ip',
                  '-4',
                ])
                if (ipResult.exitCode !== 0) {
                  throw new Error(
                    'tailscale ip -4 failed after login reached Running: ' +
                      (ipResult.stderr?.toString().trim() ||
                        ipResult.stdout?.toString().trim() ||
                        `exit code ${ipResult.exitCode}`),
                  )
                }
                const ip = parseTailscaleIp(ipResult.stdout.toString())
                const rawDns = statusData.Self?.DNSName ?? ''
                const dnsName = rawDns.endsWith('.') ? rawDns.slice(0, -1) : rawDns
                await statusJson.write(effects, { ip, dnsName })
                // Clear the persisted key now that the node is Running so it
                // is not re-applied via tailscale login on the next restart.
                try {
                  const s = (await storeJson.read().once()) ?? { ...storeData, authKey }
                  await storeJson.write(effects, { ...s, authKey: null })
                } catch {}
                console.info(
                  `[get-started] status.json updated: ip=${ip} dnsName=${dnsName}; authKey cleared`,
                )
                return
              }
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          }

          console.warn(
            `[get-started] timed out waiting for BackendState=Running (last: ${lastState}); ` +
              'login may still complete in the background',
          )
        },
      )
    } catch (err) {
      // Only suppress errors that indicate the socket is unavailable (container
      // stopped).  Any other error (bad key, network, etc.) is re-thrown so the
      // user sees it instead of silently assuming "will apply on next start".
      const msg = String(err)
      const isSocketError =
        msg.includes('no such file') ||
        msg.includes('ENOENT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('connect') ||
        msg.includes('socket')
      if (isSocketError) {
        console.info(
          `[get-started] Live login skipped — daemon socket unavailable (container stopped). ` +
            'Auth key is saved and will be applied on next start.',
        )
      } else {
        throw err
      }
    }
  },
)

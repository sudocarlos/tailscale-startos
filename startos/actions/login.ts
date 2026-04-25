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
      'Provide a Tailscale auth key for headless login, ' +
      'or leave blank and open the Web UI to sign in interactively after the service starts.',
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
            throw new Error(
              'tailscale login failed: ' +
                (loginResult.stderr?.toString().trim() ||
                  loginResult.stdout?.toString().trim() ||
                  `exit code ${loginResult.exitCode}`),
            )
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
                console.info(
                  `[get-started] status.json updated: ip=${ip} dnsName=${dnsName}`,
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
      // Container is likely stopped — the key is already persisted in store.json
      // and will be applied via TS_AUTH_KEY on the next start.
      console.info(
        `[get-started] Live login attempt skipped (container may be stopped): ${err}. ` +
          'Auth key is saved and will be applied on next start.',
      )
    }
  },
)

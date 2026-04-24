import { sdk } from '../sdk'
import { statusJson } from '../fileModels/status.json'
import { parseTailscaleIp, parseDnsName } from '../utils'

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'
const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 30_000

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  authKey: Value.text({
    name: 'Auth Key',
    description:
      'A Tailscale auth key (tskey-auth-...). Generate one at https://login.tailscale.com/admin/settings/keys',
    required: true,
    default: null,
    masked: false,
    placeholder: 'tskey-auth-...',
    warning: null,
  }),
})

export const login = sdk.Action.withInput(
  // id
  'login',

  // metadata
  async () => ({
    name: 'Login with Auth Key',
    description:
      'Authenticate to your Tailscale network using an auth key. Useful for headless provisioning without the web UI.',
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill (none)
  async () => null,

  // execution
  async ({ effects, input }) => {
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
      'tailscale-login',
      async (sub) => {
        // Authenticate with the provided auth key
        const loginResult = await sub.exec([
          'tailscale',
          '--socket=' + SOCKET,
          'login',
          '--auth-key=' + input.authKey,
        ])
        if (loginResult.exitCode !== 0) {
          throw new Error(
            'tailscale login failed: ' +
              (loginResult.stderr?.toString().trim() ||
                loginResult.stdout?.toString().trim() ||
                `exit code ${loginResult.exitCode}`),
          )
        }

        // Poll until BackendState === 'Running' so status.json reflects the
        // newly authenticated node and the URL plugin can export Tailscale URLs.
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
            console.info(`[login] BackendState: ${lastState}`)

            if (lastState === 'Running') {
              // Persist IP and DNS name so status.json is up to date and the
              // URL plugin's reactive exportUrls handler re-runs immediately.
              const ipResult = await sub.exec([
                'tailscale',
                '--socket=' + SOCKET,
                'ip',
                '-4',
              ])
              if (ipResult.exitCode === 0) {
                const ip = parseTailscaleIp(ipResult.stdout.toString())
                const dnsName = parseDnsName(statusResult.stdout.toString())
                await statusJson.write(effects, { ip, dnsName })
                console.info(`[login] status.json updated: ip=${ip} dnsName=${dnsName}`)
              }
              return
            }
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        }

        console.warn(
          `[login] timed out waiting for BackendState=Running (last: ${lastState}); ` +
            'login may still complete in the background',
        )
      },
    )
  },
)

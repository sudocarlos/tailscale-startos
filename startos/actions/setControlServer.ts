import { sdk } from '../sdk'
import {
  storeJson,
  writeStoreJson,
  defaultStore,
} from '../fileModels/store.json'
import { runTailscaleUp, pollUntilRunning, convergeAfterLogin } from '../up'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  controlServer: Value.text({
    name: 'Control Server URL (optional)',
    description:
      'URL of a custom control server, e.g. a self-hosted Headscale instance. ' +
      'Passed as `tailscale up --login-server=<url>`. ' +
      'Leave empty to use the default Tailscale control plane.',
    required: false,
    default: null,
    masked: false,
    placeholder: 'https://controlplane.tailscale.com',
    patterns: [
      {
        regex: '^https?://\\S+$',
        description:
          'Must be an http:// or https:// URL, e.g. https://headscale.example.com',
      },
    ],
    warning: null,
  }),
})

/**
 * Normalizes a user-supplied control server URL: trims whitespace and strips
 * trailing slashes.  Returns null for empty input (use the default control
 * plane).  Throws on anything that is not a valid http(s) URL with a host.
 */
function normalizeControlServer(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(
      `Invalid control server URL: "${trimmed}". ` +
        'Must be an http(s) URL, e.g. https://headscale.example.com',
    )
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) {
    throw new Error(
      `Invalid control server URL: "${trimmed}". ` +
        'Must be an http(s) URL, e.g. https://headscale.example.com',
    )
  }
  return trimmed
}

export const setControlServer = sdk.Action.withInput(
  // id
  'set-control-server',

  // metadata
  async () => ({
    name: 'Control Server',
    description:
      'Set a custom control server URL (e.g. a self-hosted Headscale instance). ' +
      'Changing it re-authenticates the node against the new server: with a ' +
      'configured auth key this is headless; otherwise an authentication link ' +
      'is shown here and in the Tailscale Daemon health message. ' +
      'Your machine name and serve configuration are preserved. ' +
      'Funnel and HTTPS serves are unavailable with a custom control server.',
    warning:
      'Changing the control server logs this node out of its current control ' +
      'plane and requires re-authentication against the new one.',
    allowedStatuses: 'any',
    group: 'Tailscale',
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill: read the currently stored control server
  async () => {
    const store = await storeJson.read().once()
    return { controlServer: store?.controlServer ?? null }
  },

  // execution
  async ({ effects, input }) => {
    const controlServer = normalizeControlServer(input.controlServer ?? '')

    const storeData = (await storeJson.read().once()) ?? defaultStore
    const previous = storeData.controlServer

    if (controlServer === previous) {
      return {
        version: '1' as const,
        title: 'Control Server',
        message: 'Control server unchanged.',
        result: null,
      }
    }

    // A stored auth key was issued for the previous control server and is
    // meaningless against the new one. The store is written before
    // converging so a crash still leaves the config consistent — the daemon
    // re-converges from the store on every start and every login.
    const store = { ...storeData, controlServer, authKey: null }
    await writeStoreJson(store)

    console.info(
      controlServer
        ? `[set-control-server] control server set to: ${controlServer}`
        : '[set-control-server] control server cleared; using the default Tailscale control plane',
    )

    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })

    try {
      return await sdk.SubContainer.withTemp(
        effects,
        { imageId: 'tailscale', sharedRun: true },
        mounts,
        'tailscale-set-control-server',
        async (sub) => {
          // `tailscale up --login-server=<url|''>` converges the daemon live;
          // runTailscaleUp retries with --force-reauth when the daemon demands
          // re-authentication for the plane switch. No logout, no restart.
          try {
            await runTailscaleUp(sub, store)
          } catch (e) {
            console.error('[set-control-server] tailscale up failed:', e)
          }

          const { running, authUrl } = await pollUntilRunning(sub, {
            timeoutMs: 20_000,
            onAuthUrl: (url) =>
              console.info(
                `[set-control-server] authentication pending — visit: ${url}`,
              ),
          })

          const target = controlServer ?? 'the default Tailscale control plane'
          if (!running) {
            return {
              version: '1' as const,
              title: 'Control Server Saved',
              message: authUrl
                ? `Control server set to ${target}. Complete login in your browser: ${authUrl}`
                : `Control server set to ${target}. It will take effect the ` +
                  'next time the service is running — watch the Tailscale ' +
                  'Daemon health message for the login link.',
              result: null,
            }
          }

          // Re-apply serves against the new control plane (plain --http under
          // a custom server) and refresh status.json for the new DNS name.
          const latest = (await storeJson.read().once()) ?? store
          await convergeAfterLogin(sub, latest)

          return {
            version: '1' as const,
            title: controlServer
              ? 'Control Server Set'
              : 'Control Server Cleared',
            message: `This node is now connected to ${target} and your serves were re-applied.`,
            result: null,
          }
        },
      )
    } catch (e) {
      // The temp subcontainer shares the running daemon — when the service
      // is stopped there is nothing to converge against. The store is
      // already written; main.ts applies it on the next start.
      const isSocketError =
        /no such file|ENOENT|ECONNREFUSED|socket|not running|unavailable/i.test(
          String(e),
        )
      if (!isSocketError) throw e
      console.info(
        '[set-control-server] daemon unavailable; control server saved for next start',
      )
      return {
        version: '1' as const,
        title: 'Control Server Saved',
        message:
          'The Tailscale daemon is not reachable (service stopped). The ' +
          'control server is saved and will take effect on next start.',
        result: null,
      }
    }
  },
)

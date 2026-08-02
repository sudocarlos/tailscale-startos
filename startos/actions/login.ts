import { sdk } from '../sdk'
import {
  storeJson,
  writeStoreJson,
  defaultStore,
} from '../fileModels/store.json'
import { runTailscaleUp, pollUntilLoggedIn, convergeAfterLogin } from '../up'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  authKey: Value.text({
    name: 'Auth Key (optional)',
    description:
      'Optionally provide an auth key to authenticate headlessly. ' +
      'For the default Tailscale control plane, generate a key (tskey-auth-...) at ' +
      'https://login.tailscale.com/admin/settings/keys. ' +
      'If a custom control server is configured (Control Server action), generate a ' +
      'preauth key on your Headscale server instead (headscale preauthkeys create). ' +
      'Leave blank and click Submit to log in interactively — the authentication ' +
      'link is shown here and in the Tailscale Daemon health message.',
    required: false,
    default: null,
    masked: true,
    placeholder: 'tskey-auth-... or Headscale preauth key',
    warning: null,
  }),
})

export const getStarted = sdk.Action.withInput(
  // id
  'get-started',

  // metadata
  async () => ({
    name: 'Login',
    description:
      'Provide an auth key to log in headlessly. ' +
      'Generate a Tailscale key at https://login.tailscale.com/admin/settings/keys, ' +
      'or a preauth key on your Headscale server if a custom control server is configured.',
    warning:
      'Alternatively, go to Dashboard and click Open UI for interactive login.',
    allowedStatuses: 'any',
    group: 'Tailscale',
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill (none)
  async () => null,

  // execution
  async ({ effects, input }) => {
    const authKey = input.authKey?.trim() ?? ''

    // Persist the key first so it is applied on the next start even when the
    // daemon is currently stopped.
    const storeData = (await storeJson.read().once()) ?? defaultStore
    const store = { ...storeData, authKey: authKey || storeData.authKey }
    if (authKey) {
      await writeStoreJson(store)
      console.info('[login] auth key saved to store.json')
    }

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
        'tailscale-login',
        async (sub) => {
          try {
            await runTailscaleUp(sub, store)
          } catch (e) {
            // runTailscaleUp only throws on real failures in its foreground
            // path. A rejected key is cleared so it is not retried on every
            // restart; transient (socket/connectivity) errors keep it — the
            // service is stopped or mid-boot and the key applies on next start.
            const msg = String(e)
            const isTransient =
              /no such file|ENOENT|ECONNREFUSED|connect|socket|timeout|timed out/i.test(
                msg,
              )
            if (authKey && !isTransient) {
              try {
                const s = (await storeJson.read().once()) ?? store
                await writeStoreJson({ ...s, authKey: null })
              } catch {}
            }
            if (isTransient) {
              console.info(
                '[login] daemon unavailable; config saved for next start',
              )
              return
            }
            throw e
          }

          // Poll frequently until the client is logged in so an interactive
          // login completed in the browser is observed promptly, and hand
          // back the link as soon as one is issued.
          const { loggedIn, authUrl } = await pollUntilLoggedIn(sub, {
            stopOnAuthUrl: true,
            onAuthUrl: (url) =>
              console.info(`[login] authentication pending — visit: ${url}`),
          })

          if (!loggedIn) {
            return {
              version: '1' as const,
              title: 'Login Pending',
              message: authUrl
                ? `Complete login in your browser: ${authUrl}`
                : 'Login is not complete yet. If the service is stopped, it ' +
                  'will be applied on next start; otherwise check the Tailscale ' +
                  'Daemon health message for the authentication link.',
              result: null,
            }
          }

          // Re-apply serves and refresh status.json (serve URLs in Interfaces).
          // convergeAfterLogin also clears the consumed key from the store.
          const latest = (await storeJson.read().once()) ?? store
          await convergeAfterLogin(sub, latest)

          return {
            version: '1' as const,
            title: 'Logged In',
            message: 'Tailscale is connected and your serves were re-applied.',
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
      console.info('[login] daemon unavailable; config saved for next start')
      return {
        version: '1' as const,
        title: authKey ? 'Auth Key Saved' : 'Login',
        message:
          'The Tailscale daemon is not reachable (service stopped). Your ' +
          'configuration is saved and will be applied on next start.',
        result: null,
      }
    }
  },
)

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
  machineName: Value.text({
    name: 'Machine Name',
    description:
      'The hostname this node will advertise on your Tailscale network. ' +
      'Only takes effect when "Auto-generate from OS hostname" is enabled ' +
      '(the default) in the Tailscale admin console. ' +
      'Must be 1–63 characters: lowercase letters, numbers, and hyphens only. ' +
      'Cannot start or end with a hyphen. ' +
      'If MagicDNS is enabled, this also determines the MagicDNS hostname.',
    required: true,
    default: 'startos',
    placeholder: 'startos',
    patterns: [
      {
        regex: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
        description:
          'Lowercase letters, numbers, and hyphens only; cannot start or end with a hyphen.',
      },
    ],
    masked: false,
    minLength: 1,
    maxLength: 63,
  }),
})

export const setMachineName = sdk.Action.withInput(
  // id
  'set-machine-name',

  // metadata
  async () => ({
    name: 'Machine Name',
    description:
      'Set the name for your machine on your Tailscale network. ' +
      'Determines MagicDNS URL, startos.example.ts.net.',
    warning:
      '"Auto-generate from OS hostname" must be enabled in the Tailscale ' +
      'admin console (default): https://login.tailscale.com/admin/machines',
    allowedStatuses: 'any',
    group: 'Tailscale',
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill: read the currently stored machine name
  async ({ effects }) => {
    const store = await storeJson.read().once()
    return { machineName: store?.machineName ?? 'startos' }
  },

  // execution
  async ({ effects, input }) => {
    const machineName = input.machineName.trim().toLowerCase()

    if (!machineName) {
      throw new Error('Machine name cannot be empty.')
    }

    // Persist the chosen name — it is passed as `tailscale up --hostname`
    // on every start, and applied live below when the daemon is reachable.
    const storeData = (await storeJson.read().once()) ?? defaultStore
    const store = { ...storeData, machineName }
    await writeStoreJson(store)

    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })

    return sdk.SubContainer.withTemp(
      effects,
      { imageId: 'tailscale', sharedRun: true },
      mounts,
      'tailscale-set-hostname',
      async (sub) => {
        try {
          await runTailscaleUp(sub, store)
        } catch (e) {
          console.error('[set-machine-name] tailscale up failed:', e)
        }

        const { running, authUrl } = await pollUntilRunning(sub, {
          timeoutMs: 15_000,
        })

        if (!running) {
          return {
            version: '1' as const,
            title: 'Machine Name Saved',
            message: authUrl
              ? `Name saved. Complete login in your browser to apply it: ${authUrl}`
              : 'Name saved. It will be applied the next time the service ' +
                'is running and logged in.',
            result: null,
          }
        }

        // Refresh serves and status.json so Interfaces show URLs for the
        // new MagicDNS name.
        const latest = (await storeJson.read().once()) ?? store
        await convergeAfterLogin(sub, latest)

        return {
          version: '1' as const,
          title: 'Machine Name Updated',
          message: `This node is now "${machineName}" on your Tailscale network.`,
          result: null,
        }
      },
    )
  },
)

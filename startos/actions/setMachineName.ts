import { sdk } from '../sdk'
import { storeJson } from '../fileModels/store.json'

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

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
    name: 'Set Machine Name',
    description: 'Set the Tailscale machine name.',
    warning:
      '"Auto-generate from OS hostname" must be enabled in the Tailscale ' +
      'admin console: https://login.tailscale.com/admin/machines',
    allowedStatuses: 'any',
    group: null,
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

    // Persist the chosen name — the set-hostname startup oneshot always
    // re-applies it on every restart, so no hostnameSet flag is needed.
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
      authKey: null,
    }

    await storeJson.write(effects, {
      ...storeData,
      machineName,
    })

    // If the service is currently running, apply the rename immediately via a
    // shared temp subcontainer so the change takes effect without a restart.
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
        'tailscale-set-hostname',
        async (sub) => {
          const r = await sub.exec([
            'tailscale',
            '--socket=' + SOCKET,
            'set',
            '--hostname=' + machineName,
          ])

          if (r.exitCode === 0) {
            console.info(`[set-machine-name] applied immediately: ${machineName}`)
          } else {
            console.info(
              `[set-machine-name] daemon not running (exit ${r.exitCode}), ` +
              `name saved to store; will apply on next start`,
            )
          }
        },
      )
    } catch (e) {
      console.info(
        '[set-machine-name] could not reach running daemon, name will be applied on next start:',
        e,
      )
    }
  },
)

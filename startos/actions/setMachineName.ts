import { sdk } from '../sdk'
import { storeJson } from '../fileModels/store.json'

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  machineName: Value.text({
    name: 'Machine Name',
    description:
      'The name this node will advertise on your Tailscale network. ' +
      'Must be lowercase letters, numbers, and hyphens only. ' +
      'If MagicDNS is enabled, this also determines the MagicDNS hostname.',
    required: true,
    default: 'startos',
    placeholder: 'startos',
    patterns: [],
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
    description:
      'Set the Tailscale machine name for this node. ' +
      'This must be completed before the service can start for the first time.',
    warning: null,
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
    const machineName = input.machineName.trim()

    if (!machineName) {
      throw new Error('Machine name cannot be empty.')
    }

    // Persist the chosen name and reset hostnameSet so the startup oneshot
    // re-applies the name on the next start (handles both first-install and
    // subsequent rename-while-stopped flows).
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
    }

    await storeJson.write(effects, {
      ...storeData,
      machineName,
      hostnameSet: false,
    })

    // If the service is currently running, apply the rename immediately via a
    // shared temp subcontainer so the change takes effect without a restart.
    // If the daemon isn't running yet (e.g. first-install, service stopped),
    // the write above is enough — the set-hostname oneshot picks it up on
    // the next start.
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
            // Mark applied so the startup oneshot skips the redundant set.
            await storeJson.write(effects, {
              ...storeData,
              machineName,
              hostnameSet: true,
            })
            console.info(`[set-machine-name] applied immediately: ${machineName}`)
          } else {
            // Daemon not running — startup oneshot will apply on next start.
            console.info(
              `[set-machine-name] daemon not running (exit ${r.exitCode}), ` +
              `name saved to store; will apply on next start`,
            )
          }
        },
      )
    } catch (e) {
      // Any error here means the daemon isn't running; startup oneshot handles it.
      console.info(
        '[set-machine-name] could not reach running daemon, name will be applied on next start:',
        e,
      )
    }
  },
)

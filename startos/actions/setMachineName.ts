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
    description:
      'Set the hostname this node advertises on your Tailscale network. ' +
      'Serve URLs (e.g. mynode.tail1234.ts.net:10001) update automatically ' +
      'once Tailscale confirms the new name. ' +
      'This only takes effect if "Auto-generate from OS hostname" is enabled ' +
      '(the default) in the Tailscale admin console. If you have manually ' +
      'renamed this machine in the admin console, that name takes precedence. ' +
      'Must be completed before the service can start for the first time.',
    warning:
      'This action only controls the hostname sent to Tailscale via ' +
      '`tailscale set --hostname`. If you have manually renamed this machine ' +
      'in the Tailscale admin console, the admin-console name takes precedence ' +
      'and this setting has no visible effect until you re-enable ' +
      '"Auto-generate from OS hostname" in the admin console.',
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

    // Persist the chosen name and reset hostnameSet so the startup oneshot
    // re-applies the name on the next start (handles both first-install and
    // subsequent rename-while-stopped flows).
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
      authKey: null,
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
            // Re-read the latest store to avoid overwriting concurrent writes
            // (e.g. addServe/removeServe running between our two writes).
            const latestStoreData = (await storeJson.read().once()) ?? {
              machineName: 'startos',
              hostnameSet: false,
              serves: {},
              authKey: null,
            }
            // Mark applied so the startup oneshot skips the redundant set.
            await storeJson.write(effects, {
              ...latestStoreData,
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

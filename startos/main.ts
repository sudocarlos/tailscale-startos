import { sdk } from './sdk'

const UI_PORT = 8080
const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info('Starting Tailscale!')

  const mounts = sdk.Mounts.of().mountVolume({
    volumeId: 'tailscale',
    subpath: null,
    mountpoint: STATE_DIR,
    readonly: false,
  })

  const subcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'tailscale' },
    mounts,
    'tailscale-sub',
  )

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
              message: 'Waiting for tailscaled to be ready...',
            }
          }
          return {
            result: 'success',
            message: 'Tailscale daemon is running',
          }
        },
        gracePeriod: 10_000,
      },
      requires: [],
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
      requires: ['tailscaled'],
    })
})

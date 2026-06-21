import { sdk } from '../sdk'
import { statusJson } from '../fileModels/status.json'
import { storeJson } from '../fileModels/store.json'
import { isSocketUnavailableError } from '../utils'

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

export const logout = sdk.Action.withoutInput(
  // id
  'logout',

  // metadata
  async () => ({
    name: 'Logout',
    description:
      'Log out of Tailscale, remove this node from your tailnet, and clear ' +
      'all persisted auth state. Use the Login action to reconnect with a new auth key.',
    warning:
      'This will immediately remove this node from your Tailscale network. ' +
      'You will need to re-authenticate to reconnect.',
    allowedStatuses: 'any' as const,
    group: 'Tailscale',
    visibility: 'enabled' as const,
  }),

  // execution
  async ({ effects }) => {
    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })

    // Attempt `tailscale logout` against the running daemon.  If the socket is
    // unavailable (service stopped) we surface a clear error rather than
    // silently wiping local state — logout requires a round-trip to the
    // Tailscale control plane to actually expire the session and remove the
    // node from the admin console.
    try {
      await sdk.SubContainer.withTemp(
        effects,
        { imageId: 'tailscale', sharedRun: true },
        mounts,
        'tailscale-logout',
        async (sub) => {
          const result = await sub.exec([
            'tailscale',
            '--socket=' + SOCKET,
            'logout',
          ])

          if (result.exitCode !== 0) {
            const stderr = result.stderr?.toString().trim() ?? ''
            const stdout = result.stdout?.toString().trim() ?? ''
            const errText = stderr || stdout || `exit code ${result.exitCode}`

            // Detect socket-unavailable errors and surface a helpful message.
            if (isSocketUnavailableError(errText)) {
              throw new Error(
                'Tailscale daemon is not running. ' +
                  'Start the service first, then use Logout to log out.',
              )
            }

            throw new Error('tailscale logout failed: ' + errText)
          }

          console.info('[logout] tailscale logout succeeded.')
        },
      )
    } catch (err) {
      const msg = String(err)

      // Re-classify raw socket errors that bubble up before exec() returns
      // (e.g. the subcontainer itself cannot connect to the shared socket).
      if (isSocketUnavailableError(msg)) {
        throw new Error(
          'Tailscale daemon is not running. ' +
            'Start the service first, then use Logout to log out.',
        )
      }

      throw err
    }

    // Logout succeeded — clean up local state that is now stale.

    // Clear any staged auth key so it is not applied on the next start
    // (the user must explicitly provide a new key via the Login action).
    try {
      const store = await storeJson.read().once()
      if (store?.authKey) {
        await storeJson.write(effects, { ...store, authKey: null })
        console.info('[logout] Cleared staged auth key from store.json.')
      }
    } catch (e) {
      console.warn('[logout] Could not clear auth key from store.json:', e)
    }

    // Clear the cached IP/DNS — they are no longer valid once the node is
    // removed from the tailnet.
    try {
      await statusJson.write(effects, { ip: '', dnsName: '' })
      console.info('[logout] Cleared status.json.')
    } catch (e) {
      console.warn('[logout] Could not clear status.json:', e)
    }

    return {
      version: '1' as const,
      title: 'Disconnected',
      message:
        'This node has been logged out of Tailscale and removed from your tailnet. ' +
        'Use the Login action to reconnect with a new auth key.',
      result: null,
    }
  },
)

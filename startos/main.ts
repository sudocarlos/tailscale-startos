import { sdk } from './sdk'
import { storeJson, defaultStore } from './fileModels/store.json'
import { runTailscaleUp, convergeAfterLogin, persistNodeStatus } from './up'
import { UI_PORT } from './constants'
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
    { imageId: 'tailscale', sharedRun: true },
    mounts,
    'tailscale-sub',
  )

  // Whether the daemon has been converged to the stored config for this
  // start cycle. A failed `tailscale up` (e.g. rejected auth key) is not
  // retried until the next start — the error is logged and the ready check
  // keeps reporting state.
  let upTriggered = false

  // Consecutive polls reporting BackendState=Running. BackendState
  // flickers through a transient Running for under a second during
  // re-authentication (e.g. --force-reauth after a control-server change)
  // before dropping back to NeedsLogin — the post-login converge fires only
  // once Running has persisted for two consecutive polls, so serves are
  // never applied against an unauthenticated daemon. Reaching the streak
  // again after the state leaves Running counts as a new transition, so a
  // mid-cycle re-authentication also restores serves and refreshes
  // status.json.
  let runningStreak = 0

  // Set on every confirmed transition into Running and cleared once the
  // post-login converge succeeds. The converge is retried on each poll
  // while pending because the daemon's netMap can lag the Running state,
  // causing transient `tailscale serve` failures right after login.
  let convergePending = false

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
              message: 'Waiting for tailscaled socket...',
            }
          }

          // Socket is responsive. BackendState is "NoState" | "NeedsLogin" |
          // "NeedsRoutineAuth" | "Stopped" | "Starting" | "Running".
          // We do NOT block on Running here — the web UI must be reachable
          // in NeedsLogin so the user can authenticate on a fresh install.
          let statusData: { BackendState?: string; AuthURL?: string }
          try {
            statusData = JSON.parse(result.stdout.toString().trim())
          } catch {
            statusData = {}
          }

          const backendState = statusData.BackendState ?? 'unknown'
          const authUrl = statusData.AuthURL ?? ''
          console.info(`[tailscaled] BackendState: ${backendState}`)

          // Converge the daemon to the stored config once per start cycle:
          // `tailscale up --hostname --login-server [--auth-key]`. Applies
          // hostname and login-server prefs whether or not the node is
          // logged in, and authenticates headlessly when a key is pending.
          // With no key and no session it starts an interactive login whose
          // AuthURL is surfaced in the health message below.
          if (!upTriggered) {
            upTriggered = true
            try {
              const store = (await storeJson.read().once()) ?? defaultStore
              await runTailscaleUp(subcontainer, store)
            } catch (e) {
              console.error('[main] tailscale up failed:', e)
            }
          }

          if (backendState === 'Running') {
            runningStreak++
            if (runningStreak === 2) convergePending = true
          } else {
            runningStreak = 0
          }

          if (backendState === 'Running') {
            if (convergePending) {
              // Post-login converge: re-apply serves, refresh status.json
              // (updates serve URLs in Interfaces), clear any consumed key.
              try {
                const store = (await storeJson.read().once()) ?? defaultStore
                await convergeAfterLogin(subcontainer, store)
                convergePending = false
              } catch (e) {
                console.error(
                  '[main] post-login converge failed (will retry):',
                  e,
                )
              }
            } else {
              // Steady state: keep status.json fresh — the MagicDNS name can
              // arrive shortly after Running. Writes are diff-gated.
              try {
                await persistNodeStatus(subcontainer)
              } catch (e) {
                console.error('[main] Failed to persist tailscale status:', e)
              }
            }
          }

          // Surface a pending auth URL in the health message and the logs so
          // the user can complete login in a browser.
          if (backendState === 'NeedsLogin' && authUrl) {
            console.info(`[main] Authentication pending — visit: ${authUrl}`)
            return {
              result: 'success',
              message: `Authenticate at: ${authUrl}`,
            }
          }

          return {
            result: 'success',
            message:
              backendState === 'Running'
                ? 'Tailscale daemon is running'
                : `Tailscale daemon ready (${backendState})`,
          }
        },
        gracePeriod: 10_000,
        // Poll frequently (2s instead of the 30s default) so login
        // completion, AuthURL surfacing, and the post-login converge are
        // all observed promptly. `tailscale status` is a cheap local call.
        trigger: sdk.trigger.cooldownTrigger(2_000),
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

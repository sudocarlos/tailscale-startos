import { sdk } from './sdk'
import { storeJson, defaultStore } from './fileModels/store.json'
import {
  runTailscaleUp,
  convergeAfterLogin,
  persistNodeStatus,
  getNodeStatus,
  loggedOutReason,
} from './up'
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

  // Consecutive polls in which the daemon held a live session with its
  // control server. Being logged in is not the same as BackendState=Running:
  // tailscaled keeps reporting Running, on the outgoing netmap, for the whole
  // of a re-authentication against a new control plane (see loggedOutReason).
  // The post-login converge fires only once the logged-in condition has held
  // for two consecutive polls, so serves are never written to a profile the
  // daemon is about to discard. Reaching the streak again after the session
  // drops counts as a new transition, so a mid-cycle re-authentication also
  // restores serves and refreshes status.json.
  let loggedInStreak = 0

  // Set on every confirmed transition into the logged-in state and cleared
  // once the post-login converge succeeds. The converge is retried on each
  // poll while pending because the daemon's netMap can lag the login,
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
          const status = await getNodeStatus(subcontainer)
          if (status === null) {
            return {
              result: 'loading',
              message: 'Waiting for tailscaled socket...',
            }
          }

          // Socket is responsive. BackendState is "NoState" | "NeedsLogin" |
          // "NeedsRoutineAuth" | "Stopped" | "Starting" | "Running".
          // We do NOT block on being logged in here — the web UI must be
          // reachable in NeedsLogin so the user can authenticate on a fresh
          // install.
          const reason = loggedOutReason(status)
          console.info(
            `[tailscaled] BackendState: ${status.state}` +
              (reason ? ` (not logged in: ${reason})` : ''),
          )

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

          const loggedIn = reason === null
          if (loggedIn) {
            loggedInStreak++
            if (loggedInStreak === 2) convergePending = true
          } else {
            loggedInStreak = 0
          }

          if (loggedIn) {
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
              // arrive shortly after login. Writes are diff-gated.
              try {
                await persistNodeStatus(subcontainer)
              } catch (e) {
                console.error('[main] Failed to persist tailscale status:', e)
              }
            }
          }

          // Surface a pending auth URL in the health message and the logs so
          // the user can complete login in a browser. This is not gated on
          // BackendState: a control-server switch leaves the daemon Running
          // on its outgoing netmap while it waits for the user to authorize
          // the node on the new plane.
          if (status.authUrl) {
            console.info(
              `[main] Authentication pending — visit: ${status.authUrl}`,
            )
            return {
              result: 'success',
              message: `Authenticate at: ${status.authUrl}`,
            }
          }

          if (loggedIn) {
            return {
              result: 'success',
              message: 'Tailscale daemon is running',
            }
          }

          return {
            result: 'success',
            message:
              status.state === 'Running'
                ? 'Tailscale daemon is not logged in — waiting for the ' +
                  'authentication link'
                : `Tailscale daemon ready (${status.state})`,
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

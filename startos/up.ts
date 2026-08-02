import { applyServicesConfig } from './serves'
import { storeJson, writeStoreJson, type Store } from './fileModels/store.json'
import { statusJson, writeStatusJson } from './fileModels/status.json'
import { parseTailscaleIp, parseDnsName } from './utils'

const SOCKET = '/var/run/tailscale/tailscaled.sock'

/**
 * Minimal subcontainer surface the helpers need — structurally compatible
 * with the daemon's own subcontainer and the temporary subcontainers
 * actions receive from sdk.SubContainer.withTemp.
 */
export interface ExecSub {
  exec(
    cmd: string[],
    opts?: { env?: Record<string, string> },
  ): Promise<{
    exitCode: number | null
    stdout: Buffer | string
    stderr: Buffer | string
  }>
}

/**
 * Reads BackendState and any pending AuthURL from the daemon.
 * Returns null when the daemon socket is unreachable (service stopped).
 */
export async function getNodeStatus(
  sub: ExecSub,
): Promise<{ state: string; authUrl: string } | null> {
  const result = await sub.exec([
    'tailscale',
    '--socket=' + SOCKET,
    'status',
    '--json',
  ])
  if (result.exitCode !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout.toString().trim()) as {
      BackendState?: string
      AuthURL?: string
    }
    return {
      state: parsed.BackendState ?? 'unknown',
      authUrl: parsed.AuthURL ?? '',
    }
  } catch {
    return { state: 'unknown', authUrl: '' }
  }
}

/**
 * Converges the daemon to the stored configuration with a single
 * `tailscale up` invocation:
 *
 *   tailscale up --hostname=<machineName> --login-server=<controlServer|''> [--auth-key=<key>]
 *
 * - `--hostname` always carries the configured machine name; `--login-server`
 *   always carries the configured control server, or an empty string to
 *   reset to the default Tailscale control plane (`tailscale up` flags are
 *   not persisted between runs, so every run passes the complete set).
 * - `--auth-key` is included only when a key is configured AND the node is
 *   not already Running (re-authenticating a healthy node with a possibly
 *   single-use key is wasteful and risks losing the session if the key is
 *   exhausted). The key travels via env, never argv.
 * - When the daemon demands re-authentication (e.g. the configured control
 *   server changed while logged in), the command is retried once with
 *   `--force-reauth`: headless when a key is configured, otherwise
 *   backgrounded — the retry produces an AuthURL against the new control
 *   plane which pollUntilRunning surfaces.
 *
 * Runs in the foreground with a bounded --timeout whenever the outcome is
 * deterministic (an auth key is configured, or the node is already Running
 * and only prefs are being converged); a timeout means prefs were applied
 * but the connection is still establishing, which the caller's polling
 * picks up. Runs in the background when interactive browser auth is
 * expected (no key, not Running), because `tailscale up` blocks until the
 * user completes login.
 *
 * No-op when the daemon socket is unreachable (service stopped): the stored
 * config is applied by main.ts on the next start.
 */
export async function runTailscaleUp(
  sub: ExecSub,
  store: Store,
): Promise<void> {
  const status = await getNodeStatus(sub)
  if (status === null) {
    console.info(
      '[up] daemon socket unavailable (service stopped); ' +
        'stored config will be applied on next start',
    )
    return
  }
  const running = status.state === 'Running'

  const buildCmd = (withAuthKey: boolean, forceReauth: boolean) => {
    const env: Record<string, string> = {
      TS_SOCKET: SOCKET,
      TS_HOSTNAME: store.machineName,
      TS_LOGIN_SERVER: store.controlServer ?? '',
    }
    let cmd =
      'tailscale --socket="$TS_SOCKET" up' +
      ' --hostname="$TS_HOSTNAME" --login-server="$TS_LOGIN_SERVER"'
    if (withAuthKey && store.authKey) {
      env.TS_AUTHKEY = store.authKey
      cmd += ' --auth-key="$TS_AUTHKEY"'
    }
    if (forceReauth) cmd += ' --force-reauth'
    return { cmd, env }
  }

  const run = (cmd: string, env: Record<string, string>, background: boolean) =>
    sub.exec(
      ['sh', '-c', background ? `${cmd} >/tmp/tailscale-up.log 2>&1 &` : cmd],
      {
        env,
      },
    )

  if (!running && !store.authKey) {
    // Interactive login expected — `tailscale up` blocks until the user
    // authenticates, so background it. The AuthURL appears in
    // `tailscale status --json` and is surfaced by the caller's polling.
    const { cmd, env } = buildCmd(false, false)
    console.info(
      '[up] no auth key configured; starting interactive login in the background',
    )
    await run(cmd, env, true)
    return
  }

  const first = buildCmd(!running, false)
  const result = await run(first.cmd + ' --timeout=30s', first.env, false)
  if (result.exitCode === 0) {
    console.info('[up] tailscale up succeeded')
    return
  }

  const errText =
    result.stderr?.toString().trim() ||
    result.stdout?.toString().trim() ||
    `exit code ${result.exitCode}`

  if (/force-reauth|reauthenticate/i.test(errText)) {
    // The configured control server changed while the node was logged in.
    // Retry with --force-reauth: headless when a key is configured,
    // backgrounded (AuthURL follows via status) otherwise.
    const retry = buildCmd(true, true)
    if (store.authKey) {
      const retryResult = await run(
        retry.cmd + ' --timeout=30s',
        retry.env,
        false,
      )
      if (retryResult.exitCode !== 0) {
        const retryErr =
          retryResult.stderr?.toString().trim() ||
          retryResult.stdout?.toString().trim() ||
          `exit code ${retryResult.exitCode}`
        throw new Error('tailscale up --force-reauth failed: ' + retryErr)
      }
      console.info('[up] re-authenticated with --force-reauth')
    } else {
      console.info(
        '[up] control server changed; re-authentication required — ' +
          'starting interactive login in the background',
      )
      await run(retry.cmd, retry.env, true)
    }
    return
  }

  if (/timeout|timed out|deadline exceeded/i.test(errText)) {
    // Prefs were applied; the connection is still establishing. The
    // caller's polling observes the outcome via `tailscale status`.
    console.info(
      '[up] tailscale up still connecting after --timeout; continuing to poll',
    )
    return
  }

  throw new Error('tailscale up failed: ' + errText)
}

/**
 * Polls `tailscale status --json` until BackendState is Running.
 *
 * Polls frequently (default 1s) so login completion is observed promptly.
 * Running must persist for `stablePolls` consecutive reads (default 3)
 * before it is trusted: BackendState flickers through a transient Running
 * for under a second during re-authentication (e.g. --force-reauth after a
 * control-server change) before dropping back to NeedsLogin, and acting on
 * the flicker would apply serves against an unauthenticated daemon
 * (`zero serverNoiseKey` failures).
 *
 * Bails out early when the daemon socket stays unreachable (service
 * stopped) rather than waiting out the full timeout. When interactive auth
 * is pending, each new AuthURL is passed to onAuthUrl as it appears.
 */
export async function pollUntilRunning(
  sub: ExecSub,
  opts: {
    intervalMs?: number
    timeoutMs?: number
    stablePolls?: number
    onAuthUrl?: (url: string) => void
  } = {},
): Promise<{ running: boolean; authUrl: string }> {
  const intervalMs = opts.intervalMs ?? 1_000
  const timeoutMs = opts.timeoutMs ?? 90_000
  const stablePolls = opts.stablePolls ?? 3
  const deadline = Date.now() + timeoutMs

  let authUrl = ''
  let misses = 0
  let runningStreak = 0
  while (Date.now() < deadline) {
    const status = await getNodeStatus(sub)
    if (status === null) {
      // Daemon socket unreachable (service stopped) — no point waiting.
      runningStreak = 0
      if (++misses >= 3) return { running: false, authUrl: '' }
    } else {
      misses = 0
      if (status.state === 'Running') {
        if (++runningStreak >= stablePolls) {
          return { running: true, authUrl: '' }
        }
      } else {
        runningStreak = 0
      }
      if (status.authUrl && status.authUrl !== authUrl) {
        authUrl = status.authUrl
        opts.onAuthUrl?.(authUrl)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { running: false, authUrl }
}

/**
 * Persists the node's tailnet IP and MagicDNS name to status.json so the
 * URL plugin reactively re-exports serve URLs in the Interfaces panel.
 * Writes only when the values actually change.
 */
export async function persistNodeStatus(sub: ExecSub): Promise<void> {
  const ipResult = await sub.exec([
    'tailscale',
    '--socket=' + SOCKET,
    'ip',
    '-4',
  ])
  if (ipResult.exitCode !== 0) return
  const statusResult = await sub.exec([
    'tailscale',
    '--socket=' + SOCKET,
    'status',
    '--json',
  ])
  if (statusResult.exitCode !== 0) return

  const ip = parseTailscaleIp(ipResult.stdout.toString())
  const dnsName = parseDnsName(statusResult.stdout.toString())
  const prev = await statusJson.read().once()
  if (!prev || prev.ip !== ip || prev.dnsName !== dnsName) {
    await writeStatusJson({ ip, dnsName })
  }
}

/**
 * Clears a consumed auth key from the store once the node is Running so it
 * is not re-applied on later restarts (the node identity is persisted in
 * tailscaled.state). Reads the store fresh to avoid clobbering concurrent
 * writes.
 */
export async function clearConsumedAuthKey(): Promise<void> {
  const store = await storeJson.read().once()
  if (store?.authKey) {
    await writeStoreJson({ ...store, authKey: null })
    console.info('[up] auth key consumed and cleared from store.json')
  }
}

/**
 * Everything that must happen once the client reaches the logged-in
 * (Running) state: re-apply the configured serves (serve state lives in
 * the daemon and is lost across logouts/control-plane switches), refresh
 * status.json so Interfaces show current serve URLs, and clear any
 * consumed auth key.
 */
export async function convergeAfterLogin(
  sub: ExecSub,
  store: Store,
): Promise<void> {
  if (Object.keys(store.serves).length > 0) {
    await applyServicesConfig(sub, store.serves, store.controlServer !== null)
    console.info('[up] serves re-applied')
  }
  await persistNodeStatus(sub)
  await clearConsumedAuthKey()
}

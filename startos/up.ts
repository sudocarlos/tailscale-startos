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

/** A peer as reported by `tailscale status --json`. */
export interface PeerSummary {
  hostName: string
  ip: string
  online: boolean
}

/** The daemon's view of itself, as reported by `tailscale status --json`. */
export interface NodeStatus {
  state: string
  authUrl: string
  health: string[]
  peers: PeerSummary[]
}

/**
 * Reads BackendState, any pending AuthURL, and the current health warnings
 * from the daemon. Returns null when the daemon socket is unreachable
 * (service stopped).
 */
export async function getNodeStatus(sub: ExecSub): Promise<NodeStatus | null> {
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
      Health?: string[]
      Peer?: Record<
        string,
        { HostName?: string; TailscaleIPs?: string[]; Online?: boolean }
      >
    }
    const peers: PeerSummary[] = []
    for (const peer of Object.values(parsed.Peer ?? {})) {
      const ip = (peer.TailscaleIPs ?? []).find((ip) => !ip.includes(':'))
      if (!ip) continue
      peers.push({
        hostName: peer.HostName ?? ip,
        ip,
        online: peer.Online === true,
      })
    }
    return {
      state: parsed.BackendState ?? 'unknown',
      authUrl: parsed.AuthURL ?? '',
      health: parsed.Health ?? [],
      peers,
    }
  } catch {
    return { state: 'unknown', authUrl: '', health: [], peers: [] }
  }
}

/**
 * Health warnings the daemon raises while the node holds no valid session
 * with its control server: "You are logged out." (optionally followed by the
 * last login error), the older "Not logged in, last login error: ...", and
 * the expired-node-key warning ("... you will need to log in again ...").
 * Matched as text because `tailscale status --json` exposes health warnings
 * as plain strings, without their warnable codes.
 *
 * Deliberately narrow, and narrower than it could be: a false positive would
 * withhold the post-login converge indefinitely on a healthy node, so
 * warnings that merely mention re-authentication ("Your node key will expire
 * in 5 days. Reauthenticate to ...") must not match.
 */
const LOGGED_OUT_HEALTH = /logged out|not logged in|log ?in again/i

/**
 * Explains why the daemon holds no live session with its control server, or
 * null when it does.
 *
 * BackendState alone is not a login signal: tailscaled reports Running
 * whenever WantRunning is set and a netmap is in memory, including while it
 * is logged out and re-registering against a different control plane
 * (`tailscale up --login-server=<new> --force-reauth` shuts the control
 * client down but leaves the outgoing netmap in place, so the node keeps
 * reporting Running for the whole re-authentication). Converging on that
 * Running writes serves into the outgoing profile, which tailscaled discards
 * once the new profile becomes active.
 *
 * A pending AuthURL and a login-state health warning each independently mean
 * the node has no session, so Running is trusted only in the absence of both.
 * The reason is surfaced (rather than a bare boolean) so the logs explain why
 * a converge is being withheld.
 */
export function loggedOutReason(status: NodeStatus): string | null {
  if (status.state !== 'Running') return `backend state is ${status.state}`
  if (status.authUrl) return 'interactive authentication is pending'
  return (
    status.health.find((warning) => LOGGED_OUT_HEALTH.test(warning)) ?? null
  )
}

/** Whether the daemon holds a live session with its control server. */
export function isLoggedIn(status: NodeStatus): boolean {
  return loggedOutReason(status) === null
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
 *   not already logged in (re-authenticating a healthy node with a possibly
 *   single-use key is wasteful and risks losing the session if the key is
 *   exhausted). The key travels via env, never argv.
 * - When the daemon demands re-authentication (e.g. the configured control
 *   server changed while logged in), the command is retried once with
 *   `--force-reauth`: headless when a key is configured, otherwise
 *   backgrounded — the retry produces an AuthURL against the new control
 *   plane which pollUntilLoggedIn surfaces.
 *
 * Runs in the foreground with a bounded --timeout whenever the outcome is
 * deterministic (an auth key is configured, or the node is already logged in
 * and only prefs are being converged); a timeout means prefs were applied
 * but the connection is still establishing, which the caller's polling
 * picks up. Runs in the background when interactive browser auth is
 * expected (no key, not logged in), because `tailscale up` blocks until the
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
  const loggedIn = isLoggedIn(status)

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

  if (!loggedIn && !store.authKey) {
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

  const first = buildCmd(!loggedIn, false)
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
 * Polls `tailscale status --json` until the daemon holds a live session with
 * its control server (see loggedOutReason for why BackendState=Running is
 * not that signal on its own).
 *
 * Polls frequently (default 1s) so login completion is observed promptly.
 * The logged-in condition must hold for `stablePolls` consecutive reads
 * (default 3) before it is trusted: the daemon can briefly report a healthy
 * Running while tearing down one control session and opening another, and
 * acting on the flicker would apply serves against an outgoing profile.
 *
 * Bails out early when the daemon socket stays unreachable (service
 * stopped) rather than waiting out the full timeout. Each new AuthURL is
 * passed to onAuthUrl as it appears; with `stopOnAuthUrl` the poll also
 * returns at that point, because a pending AuthURL means login can only be
 * completed by the user in a browser and the caller should hand over the
 * link instead of waiting out its timeout.
 */
export async function pollUntilLoggedIn(
  sub: ExecSub,
  opts: {
    intervalMs?: number
    timeoutMs?: number
    stablePolls?: number
    stopOnAuthUrl?: boolean
    onAuthUrl?: (url: string) => void
  } = {},
): Promise<{ loggedIn: boolean; authUrl: string }> {
  const intervalMs = opts.intervalMs ?? 1_000
  const timeoutMs = opts.timeoutMs ?? 90_000
  const stablePolls = opts.stablePolls ?? 3
  const deadline = Date.now() + timeoutMs

  let authUrl = ''
  let misses = 0
  let loggedInStreak = 0
  while (Date.now() < deadline) {
    const status = await getNodeStatus(sub)
    if (status === null) {
      // Daemon socket unreachable (service stopped) — no point waiting.
      loggedInStreak = 0
      if (++misses >= 3) return { loggedIn: false, authUrl: '' }
    } else {
      misses = 0
      if (isLoggedIn(status)) {
        if (++loggedInStreak >= stablePolls) {
          return { loggedIn: true, authUrl: '' }
        }
      } else {
        loggedInStreak = 0
      }
      if (status.authUrl && status.authUrl !== authUrl) {
        authUrl = status.authUrl
        opts.onAuthUrl?.(authUrl)
        if (opts.stopOnAuthUrl) return { loggedIn: false, authUrl }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { loggedIn: false, authUrl }
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
 * Originates a small amount of traffic toward online peers so the node's
 * endpoints and DERP home become known across the tailnet.
 *
 * Why: a node that has just registered against a control server appears in
 * its peers' netmaps with no endpoint and no DERP home until it has sent
 * something outbound. Until then, peer-initiated connections — and therefore
 * this node's serves — fail: the peer knows the node exists but has no way
 * to reach it. A single outbound `tailscale ping` runs path discovery and
 * publishes this node's endpoints, making the node reachable within a second
 * or two. This is user-visible on every control-server switch (headless or
 * interactive): registration alone does not establish the data path.
 *
 * Pings up to `maxPeers` online peers (`-c 1`, short timeout). If the netmap
 * has not caught up with the login yet and no peer reports online, retries
 * once after a short delay. Strictly best-effort: never throws, and a peer
 * that does not answer is not an error — one pong from any peer is enough to
 * establish the path.
 */
export async function nudgePeerPaths(
  sub: ExecSub,
  opts: { maxPeers?: number } = {},
): Promise<void> {
  const maxPeers = opts.maxPeers ?? 3
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await getNodeStatus(sub)
    const targets = (status?.peers ?? [])
      .filter((peer) => peer.online)
      .slice(0, maxPeers)
    if (targets.length > 0) {
      for (const target of targets) {
        const result = await sub.exec([
          'tailscale',
          '--socket=' + SOCKET,
          'ping',
          '-c',
          '1',
          '--timeout=3s',
          target.ip,
        ])
        const out = result.stdout.toString().trim().split('\n')[0]
        console.info(
          result.exitCode === 0
            ? `[nudge] pong from ${target.hostName} (${target.ip}): ${out}`
            : `[nudge] no reply from ${target.hostName} (${target.ip}): ${
                out || result.stderr.toString().trim()
              }`,
        )
      }
      return
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  console.info('[nudge] no online peers; skipping path warm-up')
}

/**
 * Everything that must happen once the client reaches the logged-in state:
 * re-apply the configured serves (serve state lives in the daemon, per
 * profile, and is lost across logouts and control-plane switches), refresh
 * status.json so Interfaces show current serve URLs, clear any consumed
 * auth key, and originate traffic so the node's endpoints become known to
 * its peers (a freshly registered node is dark to inbound connections until
 * it has sent something outbound).
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
  await nudgePeerPaths(sub)
}

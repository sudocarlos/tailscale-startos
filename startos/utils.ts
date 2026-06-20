import { z } from '@start9labs/start-sdk'
import { servesShape } from './fileModels/store.json'
import { UI_PORT } from './constants'

/**
 * Ports that Tailscale reserves on the tailnet or uses internally.
 * These cannot be used for serve entries.
 *  - 80, 443: reserved by Tailscale for HTTP/HTTPS on the tailnet
 *  - UI_PORT (8080): the Tailscale web UI
 *
 * NOTE: port 443 is blocked for regular serve entries but IS valid for
 * Funnel. The funnel code path uses assertFunnelPort() / assignFunnelPort()
 * instead of isPortAvailable() so it never hits this set.
 */
export const BLOCKED_PORTS = new Set([80, 443, UI_PORT])

/** The only external ports Tailscale Funnel accepts. */
export const FUNNEL_ALLOWED_PORTS = [443, 8443, 10000] as const

/**
 * Throws a user-facing error if port is not a valid Tailscale Funnel port.
 */
export function assertFunnelPort(port: number): void {
  if (!(FUNNEL_ALLOWED_PORTS as readonly number[]).includes(port)) {
    throw new Error(
      `Funnel only accepts ports ${FUNNEL_ALLOWED_PORTS.join(', ')}. ` +
      `Choose one of those or switch to Tailscale Serve mode.`,
    )
  }
}

/**
 * Returns the first unused Tailscale Funnel port from [443, 8443, 10000].
 * Throws if all three are already assigned to existing entries.
 */
export function assignFunnelPort(store: z.infer<typeof servesShape>): number {
  const allPorts = Object.values(store).flatMap((ifaces) =>
    Object.values(ifaces).map((e) => e.port),
  )
  const used = new Set(allPorts)
  for (const p of FUNNEL_ALLOWED_PORTS) {
    if (!used.has(p)) return p
  }
  throw new Error(
    `All Funnel ports (${FUNNEL_ALLOWED_PORTS.join(', ')}) are already in use. ` +
    `Remove an existing Funnel entry before adding another.`,
  )
}

/**
 * Assigns the next available Tailscale serve port.
 * Starts at 10000, increments by 1 above the current max.
 */
export function assignPort(store: z.infer<typeof servesShape>): number {
  const allPorts = Object.values(store).flatMap((ifaces) =>
    Object.values(ifaces).map((e) => e.port),
  )
  return Math.max(9999, ...allPorts) + 1
}

/**
 * Returns true if the given port is free to use for a new serve entry.
 * Rejects ports blocked by Tailscale (80, 443) or the web UI (8080),
 * and any port already assigned to an existing serve entry.
 */
export function isPortAvailable(
  store: z.infer<typeof servesShape>,
  port: number,
): boolean {
  if (BLOCKED_PORTS.has(port)) return false
  const allPorts = Object.values(store).flatMap((ifaces) =>
    Object.values(ifaces).map((e) => e.port),
  )
  return !allPorts.includes(port)
}

/**
 * Parses the output of `tailscale ip -4` to a trimmed IPv4 string.
 */
export function parseTailscaleIp(stdout: string): string {
  return stdout.trim()
}

/**
 * Parses Self.DNSName from the JSON output of `tailscale status --json`.
 * Strips the trailing dot that Tailscale appends.
 */
export function parseDnsName(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error('tailscale status --json returned empty output')
  }
  const parsed = JSON.parse(trimmed) as { Self?: { DNSName?: string } }
  const raw = parsed?.Self?.DNSName ?? ''
  return raw.endsWith('.') ? raw.slice(0, -1) : raw
}

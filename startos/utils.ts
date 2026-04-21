import { z } from '@start9labs/start-sdk'
import { shape } from './fileModels/store.json'
import { UI_PORT } from './constants'

/**
 * Ports that Tailscale reserves on the tailnet or uses internally.
 * These cannot be used for serve entries.
 *  - 80, 443: reserved by Tailscale for HTTP/HTTPS on the tailnet
 *  - UI_PORT (8080): the Tailscale web UI
 */
export const BLOCKED_PORTS = new Set([80, 443, UI_PORT])

/**
 * Assigns the next available Tailscale serve port.
 * Starts at 10000, increments by 1 above the current max.
 */
export function assignPort(store: z.infer<typeof shape>): number {
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
  store: z.infer<typeof shape>,
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

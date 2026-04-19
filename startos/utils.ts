import { z } from '@start9labs/start-sdk'
import { shape } from './fileModels/store.json'

/**
 * Assigns the next available Tailscale serve port.
 * Starts at 10000, increments by 1 above the current max.
 */
export function assignPort(store: z.infer<typeof shape>): number {
  const allPorts = Object.values(store).flatMap((ifaces) =>
    Object.values(ifaces).map((entry) => entry.port),
  )
  return Math.max(9999, ...allPorts) + 1
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

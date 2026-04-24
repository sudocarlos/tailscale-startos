<p align="center">
  <img src="icon.png" alt="Tailscale Logo" width="21%">
</p>

# Tailscale on StartOS

> **Upstream docs:** <https://tailscale.com/docs/>
>
> Everything not listed in this document should behave the same as upstream
> Tailscale. If a feature, setting, or behavior is not mentioned here, the
> upstream documentation is accurate and fully applicable.

[Tailscale](https://github.com/tailscale/tailscale) is a private WireGuard®
mesh network that connects your devices securely without port forwarding, static
IPs, or complex firewall rules. Running Tailscale on StartOS joins your StartOS
server to your tailnet, exposes the Tailscale device web interface, and lets you
expose other StartOS services to your tailnet via `tailscale serve`.

---

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Configuration Management](#configuration-management)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Actions (StartOS UI)](#actions-startos-ui)
- [Backups and Restore](#backups-and-restore)
- [Health Checks](#health-checks)
- [Dependencies](#dependencies)
- [Limitations and Differences](#limitations-and-differences)
- [What Is Unchanged from Upstream](#what-is-unchanged-from-upstream)
- [Contributing](#contributing)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Image and Container Runtime

| Property      | Value                              |
| ------------- | ---------------------------------- |
| Image         | `ghcr.io/tailscale/tailscale:v1.96.5` |
| Architectures | x86_64, aarch64                    |
| Runtime       | Two daemons in one subcontainer    |

Two daemons share a single subcontainer (with `sharedRun: true` so that action
temp containers can reach the tailscaled Unix socket):

1. **`tailscaled`** — the Tailscale daemon, running in userspace networking mode
2. **`tailscale-web`** — runs `tailscale web --listen=0.0.0.0:8080`, exposing the management UI

`tailscale-web` starts only after `tailscaled` is ready.

---

## Volume and Data Layout

| Volume      | Mount Point           | Purpose                                        |
| ----------- | --------------------- | ---------------------------------------------- |
| `tailscale` | `/var/lib/tailscale`  | Persistent daemon state and identity           |
| `startos`   | (JS runtime)          | Serve port mappings (`store.json`), cached Tailscale IP/DNS (`status.json`) |

**Key files:**

- `tailscale/tailscaled.state` — node identity, keys, and tailnet membership
- `startos/store.json` — maps `{ packageId: { interfaceId: { port, hostId, scheme, internalPort } } }` for all configured serves
- `startos/status.json` — cached `{ ip, dnsName }` written on each successful health check

All state persists across restarts. The node retains its Tailscale IP address as
long as `tailscaled.state` is intact.

---

## Installation and First-Run Flow

1. Install Tailscale from the StartOS marketplace.
2. Start the service. The two daemons start in sequence.
3. Open the **Web Interface** from the StartOS UI.
4. Log in with your Tailscale account to join the node to your tailnet.
5. Optionally configure subnet routes, exit node, or Tailscale SSH from the web interface.
6. Use the **Add Serve** tile action on any installed service to expose it on your tailnet.

No auth key or pre-configuration is required. All setup happens interactively
through the Tailscale web interface.

Alternatively, use the **Login with Auth Key** action (see [Actions](#actions-startos-ui))
to authenticate headlessly without a browser.

---

## Configuration Management

All Tailscale configuration is managed through the **Tailscale web interface**
(port 8080), which is the standard Tailscale device web UI (`tailscale web`).

| Feature             | How to configure                          |
| ------------------- | ----------------------------------------- |
| Login / auth        | Web UI → Sign in, or **Login with Auth Key** action |
| Subnet router       | Web UI → Settings → Subnet router         |
| Exit node           | Web UI → This device → Exit node          |
| Tailscale SSH       | Web UI → Settings → Tailscale SSH server  |
| Logout / re-auth    | Web UI → Settings → Log out               |
| Expose services     | URL plugin → Add Serve (tile action)      |

### Daemon environment

The daemon is started with the following fixed arguments:

| Argument                                      | Purpose                               |
| --------------------------------------------- | ------------------------------------- |
| `--state=/var/lib/tailscale/tailscaled.state` | Persistent state file path            |
| `--socket=/var/run/tailscale/tailscaled.sock` | Unix socket for CLI/web communication |
| `--tun=userspace-networking`                  | Userspace WireGuard (no kernel tun)   |

---

## Network Access and Interfaces

| Interface | Type   | Port | Description                               |
| --------- | ------ | ---- | ----------------------------------------- |
| `ui`      | Web UI | 8080 | Tailscale device management web interface |

The Tailscale web interface is accessible over LAN and Tor via the standard
StartOS interface mechanism on port 8080.

Tailscale itself uses no additional ports on the StartOS host. All WireGuard
traffic is handled internally by tailscaled in userspace networking mode.

> **Note:** Because userspace networking is used, outgoing connections from
> other containers to the wider internet via Tailscale require a SOCKS5 or HTTP
> proxy. Direct kernel-level routing (as available with `--tun`) is not used.

---

## Actions (StartOS UI)

### Login with Auth Key

Authenticates the node to your Tailscale network using a pre-generated auth key,
without requiring interactive sign-in through the web interface. Useful for
headless provisioning.

**When to use:** on a fresh install before opening the web UI, or to re-authenticate
after logging out.

**Input:**

| Field    | Required | Description |
| -------- | -------- | ----------- |
| Auth Key | Yes      | A `tskey-auth-...` key generated at <https://login.tailscale.com/admin/settings/keys> |

**What it does internally:**

1. Runs `tailscale login --auth-key=<key>` via the shared daemon socket.
2. Polls `tailscale status --json` (up to 30 seconds) until `BackendState === "Running"`.
3. Writes the node's Tailscale IP and MagicDNS name to `startos/status.json`,
   which triggers the URL plugin to immediately export updated Tailscale URLs.

If the node reaches `Running` before the timeout, the action completes silently.
If the timeout is reached, the login may still complete in the background — check
the web interface to confirm.

**Key types and expiry:**

Auth keys expire after 1–90 days (default 90). After expiry, the authenticated
node remains connected until its node key expires (default 180 days). Generate a
new auth key if you need to re-authenticate. See the
[Tailscale auth key docs](https://tailscale.com/docs/features/access-control/auth-keys)
for details on reusable, ephemeral, pre-approved, and tagged keys.

### Add Serve / Remove Serve

These actions are exposed via the **URL plugin** (the "Add Serve" / "Remove Serve" table actions
on service tiles in the StartOS UI).  They are not visible in the Actions panel directly.

**Add Serve** assigns a tailnet port to a `(packageId, interfaceId)` pair and configures
`tailscale serve` to proxy or forward traffic to that service.

- The assigned port starts at 10000 and increments by 1 above the current maximum.
- **Custom port selection:** an optional port number can be supplied when clicking "Add Serve"
  to override the auto-assigned value.
- Port assignments are stable: the same port is reused whenever "Add Serve" is clicked again
  for an entry that was previously removed (the mapping is preserved as a legacy sentinel).
- Interface metadata (`hostId`, `scheme`, `internalPort`) is read from the URL plugin prefill
  and cached in `store.json` so that subsequent startups do not require additional API calls.
- The action is idempotent: if the entry already has a `hostId` recorded, it returns immediately.
  If the entry exists but has no `hostId` (legacy record), it is upgraded in place.

**How it works internally:**

The `scheme` cached from `addressInfo` determines the `tailscale serve` target format:

- `scheme = 'http'` or `'ws'` — `tailscale serve --bg --https <port> http://<pkg>.startos:<internalPort>` (Tailscale terminates TLS)
- `scheme = 'https'` or `'wss'` — `tailscale serve --bg --https <port> https+insecure://<pkg>.startos:<internalPort>`
- `scheme = null` / TCP — `tailscale serve --bg --tcp <port> tcp://<pkg>.startos:<internalPort>`
- `packageId = 'startos'` — `tailscale serve --bg --https <port> https+insecure://startos.startos:443`

Before re-applying, `tailscale serve reset` atomically replaces the entire configuration.

**Legacy upgrade path:** If you are upgrading from a prior version of this package,
existing entries in `store.json` will be detected as legacy (no `hostId`).  The URL
plugin tile will continue to show "Add Serve".  Click it once to supply the full
metadata — the existing tailnet port is preserved.

---

## Backups and Restore

**Included in backup:**

- `tailscale` volume — daemon state, node identity, and keys
- `startos` volume — serve configuration (`store.json`)

**Restore behavior:**

- The node re-joins the tailnet with the same identity and Tailscale IP address.
- Configured serves are restored automatically on startup.
- No re-authentication is required after restore if the node has not been
  removed from the tailnet in the Tailscale admin console.
- If the node was removed from the tailnet, log in again via the web interface.

---

## Health Checks

| Check           | Display Name     | Method                                    |
| --------------- | ---------------- | ----------------------------------------- |
| `tailscaled`    | Tailscale Daemon | `tailscale status --json` exits 0         |
| `tailscale-web` | Web Interface    | TCP port 8080 is listening                |

On each successful `tailscaled` health check, the node's Tailscale IP and
MagicDNS name are written to `startos/status.json`.  Once `tailscaled` is
healthy, the `restore-serves` oneshot runs `applyServicesConfig` to restore all
non-legacy entries from `store.json` before `tailscale-web` starts.

---

## Dependencies

None. Tailscale is a standalone service.

---

## Limitations and Differences

1. **Userspace networking only** — kernel tun device is not used. Outbound
   routing for other containers requires SOCKS5 or HTTP proxy configuration.
2. **No CLI access** — interact only through the web interface or StartOS
   actions; the `tailscale` CLI is not exposed to the StartOS user directly.
3. **No Taildrop** — file transfer via Taildrop is not tested and not supported.
4. **HTTPS reverse proxy for HTTP services** — `tailscale serve --bg --https`
   is used for HTTP backends; Tailscale terminates TLS so clients access
   services over `https://`. Non-HTTP services use raw TCP forwarding.
5. **Web UI requires Tailscale v1.56.0+** — the `ghcr.io/tailscale/tailscale:v1.96.5`
   image satisfies this requirement.

---

## What Is Unchanged from Upstream

- WireGuard® encryption (automatic, always on)
- Tailnet mesh networking and DERP relay fallback
- MagicDNS
- Subnet router and exit node capabilities (configured via web UI)
- Tailscale SSH (configured via web UI)
- Node identity persistence across restarts
- Tailscale admin console compatibility

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development
workflow.

---

## Quick Reference for AI Consumers

```yaml
package_id: tailscale
image: ghcr.io/tailscale/tailscale:v1.96.5
architectures: [x86_64, aarch64]
volumes:
  tailscale: /var/lib/tailscale       # daemon state
  startos: (js runtime)               # store.json, status.json
ports:
  8080: Tailscale web interface (HTTP)
dependencies: none
daemons:
  - id: tailscaled
    command: tailscaled --state=... --socket=... --tun=userspace-networking
    health: tailscale status --json, BackendState=Running
    on_ready:
      - write ip + dnsName to startos/status.json
  - id: restore-serves   # oneshot; runs after tailscaled, blocks tailscale-web
    mechanism: |
      read startos/store.json once
      tailscale serve reset
      for each non-legacy entry (hostId != ''):
        scheme=http/ws:   tailscale serve --bg --https <port> http://<pkg>.startos:<internalPort>
        scheme=https/wss: tailscale serve --bg --https <port> https+insecure://<pkg>.startos:<internalPort>
        scheme=null/tcp:  tailscale serve --bg --tcp   <port> tcp://<pkg>.startos:<internalPort>
        packageId=startos: tailscale serve --bg --https <port> https+insecure://startos.startos:443
  - id: tailscale-web
    command: tailscale web --listen=0.0.0.0:8080
    health: port 8080 listening
    requires: [tailscaled, restore-serves]
actions:
  - id: add-serve   # exposed via URL plugin table action
    description: Assign a tailnet port and configure tailscale serve for a service interface
    input: urlPluginMetadata { packageId, interfaceId, hostId, internalPort }
    optional_input: port (number) — custom port override; defaults to auto-assign from 10000
    state: startos/store.json
    schema: { packageId: { interfaceId: { port, hostId, scheme, internalPort } } }
    idempotent: skip if hostId already stored; upgrade legacy sentinel (hostId='') in place
  - id: remove-serve   # exposed via URL plugin table action
    description: Remove a tailscale serve for a service interface
    state: startos/store.json
  - id: login   # visible in the Actions panel
    description: Authenticate using a Tailscale auth key (headless login)
    input: authKey (string, required) — tskey-auth-... from admin console
    behavior: |
      tailscale login --auth-key=<key>
      poll BackendState until Running (30s timeout)
      write ip + dnsName to startos/status.json (triggers URL plugin refresh)
```

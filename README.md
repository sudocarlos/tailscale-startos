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
| Image         | `tailscale/tailscale:stable`       |
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
- `startos/store.json` — maps `{ packageId: { interfaceId: tailnetPort } }` for all configured serves
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
6. Use **Manage Serves** to expose other StartOS services onto your tailnet.

No auth key or pre-configuration is required. All setup happens interactively
through the Tailscale web interface.

---

## Configuration Management

All Tailscale configuration is managed through the **Tailscale web interface**
(port 8080), which is the standard Tailscale device web UI (`tailscale web`).

| Feature             | How to configure                          |
| ------------------- | ----------------------------------------- |
| Login / auth        | Web UI → Sign in                          |
| Subnet router       | Web UI → Settings → Subnet router         |
| Exit node           | Web UI → This device → Exit node          |
| Tailscale SSH       | Web UI → Settings → Tailscale SSH server  |
| Logout / re-auth    | Web UI → Settings → Log out               |
| Expose services     | Actions → Manage Serves                   |

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

### Manage Serves

Exposes StartOS services on your tailnet via `tailscale serve --tcp`.

- Presents a list of all installed packages and their service interfaces.
- Each selected service/interface is assigned a unique tailnet port (starting at
  10000, incrementing by 1).
- Existing port assignments are preserved when the list is updated.
- Removing a serve tears down both the `tailscale serve` rule and the local TCP proxy.

**How it works internally:**

Because `tailscale serve --tcp` only forwards to `localhost`, a Node.js TCP
proxy is started for each serve: `127.0.0.1:<tailnetPort>` →
`<packageId>.startos:<internalPort>`. Tailscale then forwards tailnet traffic to
that local proxy, which bridges it to the service on the StartOS internal
network.

Serves and their TCP proxies are automatically restored on daemon startup from
`store.json`.

### View Serves

Displays all currently configured serves with their full addresses.

- Shows both the Tailscale IP and MagicDNS hostname for each serve.
- Detects the service interface scheme (`http`, `https`, etc.) from the StartOS
  service interface metadata and uses it in the displayed URL.
- Disabled when no serves are configured.
- Only available while the service is running.

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
MagicDNS name are written to `startos/status.json` for use by the View Serves
action. Serves from `store.json` are also restored on the first successful
health check after startup.

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
4. **TCP-only serves** — `tailscale serve --tcp` is used for all serves; HTTP/HTTPS
   Tailscale serve is not currently used, though the displayed URL scheme is
   inferred from the service interface metadata.
5. **Web UI requires Tailscale v1.56.0+** — the `tailscale/tailscale:stable`
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
image: tailscale/tailscale:stable
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
    health: tailscale status --json exits 0
    on_ready:
      - write ip + dnsName to startos/status.json
      - restore tailscale serve rules + TCP proxies from startos/store.json (once)
  - id: tailscale-web
    command: tailscale web --listen=0.0.0.0:8080
    health: port 8080 listening
    requires: [tailscaled]
actions:
  - id: manage-serves
    description: Add/remove tailscale serve rules for installed StartOS services
    input: list of { packageId, interfaceId } pairs
    state: startos/store.json
    mechanism: Node.js TCP proxy (127.0.0.1:<port> -> <pkg>.startos:<internalPort>)
               + tailscale serve --bg --tcp=<port> tcp://localhost:<port>
  - id: view-serves
    description: Display tailnet URLs for all configured serves
    state: startos/store.json + startos/status.json
    url_scheme: inferred from serviceInterface.addressInfo.scheme
```

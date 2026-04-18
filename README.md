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
server to your tailnet and exposes the Tailscale device web interface so you can
manage everything from a browser.

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

Two daemons share a single subcontainer:

1. **`tailscaled`** — the Tailscale daemon, running in userspace networking mode
2. **`tailscale-web`** — runs `tailscale web --listen=0.0.0.0:8080`, exposing the management UI

`tailscale-web` starts only after `tailscaled` is ready.

---

## Volume and Data Layout

| Volume      | Mount Point           | Purpose                              |
| ----------- | --------------------- | ------------------------------------ |
| `tailscale` | `/var/lib/tailscale`  | Persistent daemon state and identity |

**Key files inside the volume:**

- `tailscaled.state` — node identity, keys, and tailnet membership

This state persists across restarts and across StartOS reboots. The node retains
its Tailscale IP address as long as the state file is intact.

---

## Installation and First-Run Flow

1. Install Tailscale from the StartOS marketplace.
2. Start the service. The two daemons start in sequence.
3. Open the **Web Interface** from the StartOS UI.
4. Log in with your Tailscale account to join the node to your tailnet.
5. Optionally configure subnet routes, exit node, or Tailscale SSH from the web
   interface.

No auth key or pre-configuration is required. All setup happens interactively
through the Tailscale web interface.

---

## Configuration Management

All Tailscale configuration is managed through the **Tailscale web interface**
(port 8080), which is the standard Tailscale device web UI (`tailscale web`).
There are no StartOS config forms or actions — the upstream web UI handles
everything:

| Feature             | How to configure                          |
| ------------------- | ----------------------------------------- |
| Login / auth        | Web UI → Sign in                          |
| Subnet router       | Web UI → Settings → Subnet router         |
| Exit node           | Web UI → This device → Exit node          |
| Tailscale SSH       | Web UI → Settings → Tailscale SSH server  |
| Logout / re-auth    | Web UI → Settings → Log out               |

### Daemon environment

The daemon is started with the following fixed arguments:

| Argument                                    | Purpose                              |
| ------------------------------------------- | ------------------------------------ |
| `--state=/var/lib/tailscale/tailscaled.state` | Persistent state file path           |
| `--socket=/var/run/tailscale/tailscaled.sock` | Unix socket for CLI/web communication |
| `--tun=userspace-networking`                  | Userspace WireGuard (no kernel tun)  |

---

## Network Access and Interfaces

| Interface | Type   | Port | Description                          |
| --------- | ------ | ---- | ------------------------------------ |
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

None. All configuration is handled through the Tailscale web interface.

---

## Backups and Restore

**Included in backup:**

- `tailscale` volume — daemon state, node identity, and keys

**Restore behavior:**

- The node re-joins the tailnet with the same identity and Tailscale IP address.
- No re-authentication is required after restore if the node has not been removed
  from the tailnet in the Tailscale admin console.
- If the node was removed from the tailnet, log in again via the web interface.

---

## Health Checks

| Check           | Display Name       | Method                                       |
| --------------- | ------------------ | -------------------------------------------- |
| `tailscaled`    | Tailscale Daemon   | `tailscale status --json` exits 0            |
| `tailscale-web` | Web Interface      | TCP port 8080 is listening                   |

The `tailscale-web` health check becomes ready only after `tailscaled` is ready.

---

## Dependencies

None. Tailscale is a standalone service.

---

## Limitations and Differences

1. **Userspace networking only** — kernel tun device is not used. Outbound
   routing for other containers requires SOCKS5 or HTTP proxy configuration.
2. **No CLI access** — interact only through the web interface; the `tailscale`
   CLI is not exposed to the StartOS user.
3. **No Taildrop** — file transfer via Taildrop is not tested and not supported.
4. **Web UI requires Tailscale v1.56.0+** — the `tailscale/tailscale:stable`
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
  tailscale: /var/lib/tailscale
ports:
  8080: Tailscale web interface (HTTP)
dependencies: none
daemons:
  - id: tailscaled
    command: tailscaled --state=... --socket=... --tun=userspace-networking
    health: tailscale status --json exits 0
  - id: tailscale-web
    command: tailscale web --listen=0.0.0.0:8080
    health: port 8080 listening
    requires: [tailscaled]
actions: none
```

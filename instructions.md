# Tailscale

## Documentation

- [Tailscale documentation](https://tailscale.com/docs/) — the official reference for all Tailscale features, settings, and concepts.

## What you get on StartOS

Installing Tailscale joins your StartOS server to your [tailnet](https://tailscale.com/kb/1136/tailnet) — your private WireGuard® mesh network — and gives you a browser-based management UI. Once it's running, you can also share individual StartOS services over your tailnet via **Add Serve**, or to the public internet via **Funnel**, on their tiles in the Services panel.

## Getting set up

1. After installation, a task will appear asking you to **Set Machine Name**. This is the hostname your server will advertise on your tailnet (for example, as `startos.tail1234.ts.net` with MagicDNS). Accept the default or type a custom name, then complete the task.
2. Start the service.
3. Open the **Web Interface** from the Dashboard tab. You'll land on the Tailscale device web UI.
4. Click **Log in** and authenticate with your Tailscale account to join the node to your tailnet.

Your StartOS server is now on your tailnet. If you prefer not to open a browser, use the **Login** action instead (see below).

> **Using Headscale?** Run the **Control Server** action and enter your Headscale server's URL (for example `https://headscale.example.com`) before logging in. Then either run the **Login** action with a preauth key (`headscale preauthkeys create --user <user>`) to authenticate without a browser, or follow the authentication link shown in the **Tailscale Daemon** health message.

## Using Tailscale

### Web interface

The web interface is the standard Tailscale device UI running on your server. Use it to configure subnet routing, exit node, Tailscale SSH, and other per-device settings — the same controls you'd find in the Tailscale app on any other device.

### Actions

**Machine Name** — sets the hostname your server advertises on the tailnet and in MagicDNS. A setup task runs this automatically after install, but you can re-run it at any time to rename the device. The change takes effect immediately if the service is running, or on the next start if it's stopped.

> This only applies when the device name is set to auto-generate from your OS hostname in the [Tailscale admin console](https://login.tailscale.com/admin/machines) — the default for new devices. If you've manually renamed this machine in the admin console, that name takes precedence until you re-enable auto-generation.

**Control Server** — sets a custom control server URL, such as a self-hosted [Headscale](https://headscale.net) instance. Leave empty to use the official Tailscale service. Changing it re-authenticates the node against the new server — no restart needed: with an auth key configured via the Login action this is automatic, otherwise the action returns an authentication link (also shown in the Tailscale Daemon health message). Your machine name and shared services are preserved.

**Login** — authenticates the node using a [Tailscale auth key](https://tailscale.com/kb/1085/auth-keys) without opening a browser. Generate a key at <https://login.tailscale.com/admin/settings/keys>, paste it in, and run the action. If a custom control server is set, generate a preauth key on your Headscale server instead. Useful for headless setups or when you can't reach the web interface. Leave the field blank and the action returns a link to sign in interactively.

### Sharing services

After Tailscale is running, each installed service gains an **Add Serve** option. Click it to assign that service a port and make it reachable. You can choose between two modes:

- **Serve** (default) — tailnet-only, accessible at `https://<machine-name>.tail1234.ts.net:<port>`. Any available port can be used.
- **Funnel** — public internet, accessible at `https://<machine-name>.ts.net:<port>`. Ports 443, 8443, and 10000 only. Must be enabled in the [Tailscale admin console](https://login.tailscale.com/admin/settings/funnel).

> **Security note:** Funnel makes your service visible to anyone on the internet. Only use it for services intended to be public.

> **Custom control server:** with a Headscale URL configured, serves are plain `http://` (Headscale cannot provision TLS certificates) and Funnel is unavailable. Serve URLs use the node's Tailscale IP if your Headscale server has no MagicDNS configured.

To stop sharing a service, click **Remove Serve** on the same tile.

## Limitations

- **Userspace networking** — Tailscale runs without a kernel tun device. Outbound connections from other containers to the internet through Tailscale as an exit node require SOCKS5 or HTTP proxy configuration.
- **No Taildrop** — file transfer via Taildrop is not supported in this package.
- **Headscale caveats** — with a custom control server set, serves are plain `http://` (no TLS certificates) and Funnel is unavailable.

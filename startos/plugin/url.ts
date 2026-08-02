import { addServe } from '../actions/addServe'
import { removeServe } from '../actions/removeServe'
import { statusJson } from '../fileModels/status.json'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

export const registerUrlPlugin = sdk.setupOnInit(async (effects) =>
  sdk.plugin.url.register(effects, { tableAction: addServe }),
)

export const exportUrls = sdk.plugin.url.setupExportedUrls(
  async ({ effects }) => {
    // Reactive reads — framework re-runs this handler when either file changes.
    const storeData = (await storeJson.read().const(effects)) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
      authKey: null,
      controlServer: null,
    }
    const status = await statusJson.read().const(effects)
    if (!status) return

    // Proxy serves are plain HTTP when a custom control server is configured
    // (a Headscale server cannot provision the TLS certs --https requires),
    // so exported URLs must not carry the TLS label.
    const customControlServer = storeData.controlServer !== null

    // Collect candidate entries, skipping legacy and startos self-target.
    const candidates: Array<{
      packageId: string
      interfaceId: string
      port: number
      hostId: string
      scheme: string | null
      mode: 'serve' | 'funnel'
    }> = []

    for (const [packageId, ifaces] of Object.entries(storeData.serves)) {
      for (const [interfaceId, entry] of Object.entries(ifaces)) {
        // Skip legacy entries — they have no hostId/scheme cached yet.
        // The URL plugin tile will continue to show "Add Serve"; the user
        // re-clicks once to supply the full metadata.
        if (entry.hostId === '') continue

        // Skip funnel entries when a custom control server is set — they are
        // not applied (Funnel is Tailscale-cloud-only), so exporting a public
        // URL would advertise something that does not exist.
        if (entry.mode === 'funnel' && customControlServer) continue

        candidates.push({
          packageId,
          interfaceId,
          port: entry.port,
          hostId: entry.hostId,
          scheme: entry.scheme,
          mode: entry.mode,
        })
      }
    }

    // Resolve live internalPort for each entry in parallel (Fix B).
    // Using .once() per interface avoids stacking live subscriptions (Fix C).
    await Promise.all(
      candidates.map(
        async ({ packageId, interfaceId, port, hostId, scheme, mode }) => {
          let internalPort: number

          if (packageId === 'startos') {
            // StarOS has no registered service interface; UI is always at port 80
            internalPort = 80
          } else {
            try {
              const host = await sdk.host
                .get(effects, { hostId, packageId })
                .once()
              const iface = host
                ? Object.values(host.bindings)
                    .flatMap((b) => Object.values(b.interfaces))
                    .find((i) => i.id === interfaceId)
                : null

              if (!iface) {
                console.warn(
                  `[plugin/url] interface ${packageId}/${interfaceId} not found (package uninstalled?), skipping`,
                )
                return
              }

              internalPort = iface.addressInfo.internalPort
            } catch (e) {
              console.warn(
                `[plugin/url] could not resolve internalPort for ${packageId}/${interfaceId}, skipping:`,
                e,
              )
              return
            }
          }

          // PluginHostnameInfo only exposes `ssl: boolean`, which StartOS maps
          // to an HTTPS/HTTP protocol label in the URL plugin tile. There is no
          // TCP option in the current SDK type, so raw TCP serves (scheme ===
          // null, e.g. ZMQ, Bitcoin peer) are mislabelled as "HTTP" in the UI.
          // The serve itself is configured correctly with `--tcp` and works as
          // expected; only the displayed protocol label is wrong. Track the
          // upstream SDK/platform change to add a TCP label before reworking
          // this.
          const ssl =
            !customControlServer &&
            (scheme === 'http' ||
              scheme === 'ws' ||
              scheme === 'https' ||
              scheme === 'wss')
          // Only Funnel entries are truly public (internet-accessible).
          // Serve entries stay within the private tailnet.
          const isPublic = mode === 'funnel'

          await sdk.plugin.url
            .exportUrl(effects, {
              hostnameInfo: {
                // StartOS expects the literal id 'start_os' for its own UI
                // host; other services use their string packageId.
                packageId: packageId === 'startos' ? 'start_os' : packageId,
                hostId,
                internalPort,
                ssl,
                public: isPublic,
                // Fall back to the tailnet IP when no MagicDNS name is
                // available (e.g. a Headscale server without MagicDNS
                // configured) — an empty hostname would fail URL export
                // entirely, leaving stale tiles behind.
                hostname: status.dnsName || status.ip,
                port,
                info: null,
              },
              removeAction: removeServe,
              overflowActions: [],
            })
            .catch((e) => {
              console.error(
                `[plugin/url] failed to export url for ${packageId}/${interfaceId}:`,
                e,
              )
            })
        },
      ),
    )
  },
)

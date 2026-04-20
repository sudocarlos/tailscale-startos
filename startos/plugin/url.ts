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
    const store = (await storeJson.read().const(effects)) || {}
    const status = await statusJson.read().const(effects)
    if (!status) return

    // Collect candidate entries, skipping legacy and startos self-target.
    const candidates: Array<{
      packageId: string
      interfaceId: string
      port: number
      hostId: string
      scheme: string | null
    }> = []

    for (const [packageId, ifaces] of Object.entries(store)) {
      // Skip StartOS self-target — not a supported serve target.
      if (packageId === 'startos') continue

      for (const [interfaceId, entry] of Object.entries(ifaces)) {
        // Skip legacy entries — they have no hostId/scheme cached yet.
        // The URL plugin tile will continue to show "Add Serve"; the user
        // re-clicks once to supply the full metadata.
        if (entry.hostId === '') continue

        candidates.push({
          packageId,
          interfaceId,
          port: entry.port,
          hostId: entry.hostId,
          scheme: entry.scheme,
        })
      }
    }

    // Resolve live internalPort for each entry in parallel (Fix B).
    // Using .once() per interface avoids stacking live subscriptions (Fix C).
    await Promise.all(
      candidates.map(async ({ packageId, interfaceId, port, hostId, scheme }) => {
        let internalPort: number

        try {
          const iface = await sdk.serviceInterface
            .get(effects, { id: interfaceId, packageId })
            .once()

          if (!iface || !iface.addressInfo) {
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

        // PluginHostnameInfo only exposes `ssl: boolean`, which StartOS maps
        // to an HTTPS/HTTP protocol label in the URL plugin tile. There is no
        // TCP option in the current SDK type, so raw TCP serves (scheme ===
        // null, e.g. ZMQ, Bitcoin peer) are mislabelled as "HTTP" in the UI.
        // The serve itself is configured correctly with `--tcp` and works as
        // expected; only the displayed protocol label is wrong. Track the
        // upstream SDK/platform change to add a TCP label before reworking
        // this.
        const ssl = scheme === 'http' || scheme === 'ws' || scheme === 'https' || scheme === 'wss'

        await sdk.plugin.url
          .exportUrl(effects, {
            hostnameInfo: {
              packageId,
              hostId,
              internalPort,
              ssl,
              public: true,
              hostname: status.dnsName,
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
      }),
    )
  },
)

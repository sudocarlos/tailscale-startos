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

    for (const [packageId, ifaces] of Object.entries(store)) {
      for (const [interfaceId, entry] of Object.entries(ifaces)) {
        // Skip legacy entries — they have no hostId/scheme cached yet.
        // The URL plugin tile will continue to show "Add Serve"; the user
        // re-clicks once to supply the full metadata.
        if (entry.hostId === '') continue

        const { port, hostId, scheme, internalPort } = entry
        const ssl = scheme === 'http' || scheme === 'https'

        await sdk.plugin.url
          .exportUrl(effects, {
            hostnameInfo: {
              packageId: packageId === 'startos' ? null : packageId,
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
      }
    }
  },
)

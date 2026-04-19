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
    const store = (await storeJson.read().const(effects)) || {}
    const status = await statusJson.read().const(effects)
    if (!status) return

    for (const [packageId, ifaces] of Object.entries(store)) {
      for (const [interfaceId, port] of Object.entries(ifaces)) {
        let ssl = false
        let internalPort = port

        if (packageId === 'startos') {
          ssl = true
          internalPort = 443
        } else {
          const iface = await sdk.serviceInterface
            .get(effects, { id: interfaceId, packageId })
            .once()
          const scheme = iface?.addressInfo?.scheme
          ssl = scheme === 'http' || scheme === 'https'
          internalPort = iface?.addressInfo?.internalPort ?? port
        }

        await sdk.plugin.url
          .exportUrl(effects, {
            hostnameInfo: {
              packageId: packageId === 'startos' ? null : packageId,
              hostId: interfaceId,
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

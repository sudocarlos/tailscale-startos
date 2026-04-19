import { storeJson } from '../fileModels/store.json'
import { statusJson } from '../fileModels/status.json'
import { sdk } from '../sdk'

export const viewServes = sdk.Action.withoutInput(
  // id
  'view-serves',

  // metadata
  async ({ effects }) => ({
    name: 'View Serves',
    description: 'View the Tailscale addresses for your exposed services',
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: Object.keys((await storeJson.read().const(effects)) || {}).length
      ? 'enabled'
      : { disabled: 'You have no serves configured' },
  }),

  // execution
  async ({ effects }) => {
    const store = (await storeJson.read().once()) || {}
    const status = await statusJson.read().once()

    if (!status) {
      throw new Error('Tailscale status not yet available. Please wait for the daemon to be ready.')
    }

    const { ip, dnsName } = status

    const entries = await Promise.all(
      Object.entries(store).flatMap(([packageId, ifaces]) =>
        Object.entries(ifaces).map(async ([interfaceId, entry]) => {
          const { port, httpProxy } = entry
          let label: string
          // httpProxy entries are served as HTTPS on the tailnet (TLS terminated by Tailscale)
          const scheme = httpProxy ? 'https' : 'tcp'

          if (packageId === 'startos') {
            label = 'StartOS UI'
          } else {
            const packageTitle =
              (await sdk
                .getServiceManifest(effects, packageId, (m) => m?.title)
                .const()) ?? packageId
            const iface = await sdk.serviceInterface
              .get(effects, { id: interfaceId, packageId })
              .once()
            const ifaceName = iface?.name || 'unknown'
            label = `${packageTitle} - ${ifaceName}`
          }

          return [
            {
              type: 'single' as const,
              name: `${label} (IP)`,
              description: null,
              value: `${scheme}://${ip}:${port}`,
              masked: false,
              copyable: true,
              qr: false,
            },
            {
              type: 'single' as const,
              name: `${label} (MagicDNS)`,
              description: null,
              value: `${scheme}://${dnsName}:${port}`,
              masked: false,
              copyable: true,
              qr: false,
            },
          ]
        }),
      ),
    )

    return {
      version: '1' as const,
      title: 'Tailscale Serves',
      message: null,
      result: {
        type: 'group' as const,
        value: entries.flat(),
      },
    }
  },
)

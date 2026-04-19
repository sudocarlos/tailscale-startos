import { statusJson } from '../fileModels/status.json'
import { storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'

export const viewServes = sdk.Action.withoutInput(
  // id
  'view-serves',

  // metadata
  async ({ effects }) => {
    let hasServes = false
    try {
      const store = (await storeJson.read().const(effects)) || {}
      hasServes = Object.keys(store).length > 0
    } catch {
      // ignore — fall through to disabled
    }

    return {
      name: 'View Serves',
      description: 'View the Tailscale addresses for your exposed services',
      warning: null,
      allowedStatuses: 'only-running',
      group: null,
      visibility: hasServes
        ? 'enabled'
        : { disabled: 'You have no serves configured' },
    }
  },

  // execution
  async ({ effects }) => {
    const status = await statusJson.read().once()
    if (!status) {
      throw new Error('Tailscale status not yet available. Please wait for the daemon to be ready.')
    }
    const { ip, dnsName } = status

    const store = (await storeJson.read().once()) || {}

    type ServiceEntry = { port: number; scheme: string; packageId: string; interfaceId: string }
    const serviceEntries: ServiceEntry[] = []

    for (const [packageId, ifaces] of Object.entries(store)) {
      for (const [interfaceId, port] of Object.entries(ifaces)) {
        let scheme: string
        if (packageId === 'startos') {
          scheme = 'https'
        } else {
          const iface = await sdk.serviceInterface
            .get(effects, { id: interfaceId, packageId })
            .once()
          scheme = iface?.addressInfo?.scheme === 'http' ? 'https' : 'tcp'
        }
        serviceEntries.push({ port, scheme, packageId, interfaceId })
      }
    }

    const outputEntries = await Promise.all(
      serviceEntries.map(async ({ port, scheme, packageId, interfaceId }) => {
        let label: string
        if (packageId === 'startos') {
          label = 'StartOS UI'
        } else {
          const packageTitle =
            (await sdk
              .getServiceManifest(effects, packageId, (m) => m?.title)
              .once()) ?? packageId
          const iface = await sdk.serviceInterface
            .get(effects, { id: interfaceId, packageId })
            .once()
          const ifaceName = iface?.name ?? 'unknown'
          label = `${packageTitle} - ${ifaceName}`
        }

        if (scheme === 'https') {
          return [
            {
              type: 'single' as const,
              name: label,
              description: null,
              value: `https://${dnsName}:${port}`,
              masked: false,
              copyable: true,
              qr: false,
            },
          ]
        }

        return [
          {
            type: 'single' as const,
            name: `${label} (IP)`,
            description: null,
            value: `tcp://${ip}:${port}`,
            masked: false,
            copyable: true,
            qr: false,
          },
          {
            type: 'single' as const,
            name: `${label} (MagicDNS)`,
            description: null,
            value: `tcp://${dnsName}:${port}`,
            masked: false,
            copyable: true,
            qr: false,
          },
        ]
      }),
    )

    return {
      version: '1' as const,
      title: 'Tailscale Serves',
      message: null,
      result: {
        type: 'group' as const,
        value: outputEntries.flat(),
      },
    }
  },
)

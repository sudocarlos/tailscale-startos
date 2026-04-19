import { statusJson } from '../fileModels/status.json'
import { sdk } from '../sdk'

const SOCKET = '/var/run/tailscale/tailscaled.sock'
const STATE_DIR = '/var/lib/tailscale'

export const viewServes = sdk.Action.withoutInput(
  // id
  'view-serves',

  // metadata
  async ({ effects }) => {
    // Check if any serves are configured by reading the live config
    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })
    let hasServes = false
    try {
      await sdk.SubContainer.withTemp(
        effects,
        { imageId: 'tailscale', sharedRun: true },
        mounts,
        'tailscale-view-check',
        async (sub) => {
          const result = await sub.exec([
            'tailscale', '--socket=' + SOCKET, 'serve', 'get-config', '--all',
          ])
          if (result.exitCode === 0) {
            const config = JSON.parse(result.stdout.toString().trim())
            hasServes = Object.keys(config?.services ?? {}).length > 0
          }
        },
      )
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

    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })

    type ServiceEntry = { port: number; scheme: string; packageId: string; interfaceId: string }
    let serviceEntries: ServiceEntry[] = []

    await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'tailscale', sharedRun: true },
      mounts,
      'tailscale-view-serves',
      async (sub) => {
        const result = await sub.exec([
          'tailscale', '--socket=' + SOCKET, 'serve', 'get-config', '--all',
        ])
        if (result.exitCode !== 0) {
          throw new Error(`tailscale serve get-config --all failed: ${result.stderr.toString()}`)
        }

        const config = JSON.parse(result.stdout.toString().trim()) as {
          version: string
          services: Record<string, { endpoints: Record<string, string> }>
        }

        for (const [svcName, svcDef] of Object.entries(config.services ?? {})) {
          // svcName format: "svc:<packageId>-<interfaceId>"
          const match = svcName.match(/^svc:(.+)-([^-]+)$/)
          if (!match) continue
          const packageId = match[1]
          const interfaceId = match[2]

          for (const [endpointKey, localTarget] of Object.entries(svcDef.endpoints ?? {})) {
            // endpointKey format: "tcp:<port>"
            const portMatch = endpointKey.match(/^tcp:(\d+)$/)
            if (!portMatch) continue
            const port = parseInt(portMatch[1], 10)

            // Local target starting with "http://" means Tailscale does TLS
            // termination — the client-facing URL is https://
            const scheme = localTarget.startsWith('http://') ? 'https' : 'tcp'

            serviceEntries.push({ port, scheme, packageId, interfaceId })
          }
        }
      },
    )

    const outputEntries = await Promise.all(
      serviceEntries.map(async ({ port, scheme, packageId, interfaceId }) => {
        let label: string
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
          const ifaceName = iface?.name ?? 'unknown'
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

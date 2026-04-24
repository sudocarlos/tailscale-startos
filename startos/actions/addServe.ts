import { servesShape, storeJson } from '../fileModels/store.json'
import { applyServicesConfig } from '../serves'
import { sdk } from '../sdk'
import { assignPort, isPortAvailable, BLOCKED_PORTS } from '../utils'
import { z } from '@start9labs/start-sdk'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  urlPluginMetadata: Value.hidden<{
    packageId: string
    interfaceId: string
    hostId: string
    internalPort: number
  }>(),
  port: Value.number({
    name: 'Tailnet Port',
    description:
      'Port to expose on your Tailscale network. Leave blank to auto-assign.',
    required: false,
    default: null,
    integer: true,
    min: 1,
    max: 65535,
    placeholder: 'auto-assign',
  }),
})

export const addServe = sdk.Action.withInput(
  // id
  'add-serve',

  // metadata
  async () => ({
    name: 'Add Serve',
    description: 'Expose this interface on your Tailscale network via tailscale serve',
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: 'hidden',
  }),

  // input spec
  inputSpec,

  // pre-fill (none — system provides urlPluginMetadata)
  async () => null,

  // execution
  async ({ effects, input }) => {
    const { packageId: rawPkgId, interfaceId, hostId, internalPort } =
      input.urlPluginMetadata
    const packageId = rawPkgId ?? 'startos'
    // Use .once() to avoid "write after const" error
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
    }
    const serves: z.infer<typeof servesShape> = storeData.serves

    const existing = serves[packageId]?.[interfaceId]

    console.info(
      `[addServe] ${packageId}/${interfaceId} existing:`,
      JSON.stringify(existing ?? null),
    )

    // Fully configured entry — nothing to do
    if (existing !== undefined && existing.hostId !== '') {
      console.info(`[addServe] ${packageId}/${interfaceId} already configured — skipping`)
      return
    }

    // Resolve scheme and internal port from the service interface.
    // StarOS itself has no registered service interface; its UI is always
    // reachable at http://startos:80 inside the container network.
    let scheme: string | null
    let resolvedInternalPort: number

    if (packageId === 'startos') {
      scheme = 'http'
      resolvedInternalPort = 80
    } else {
      const iface = await sdk.serviceInterface
        .get(effects, { id: interfaceId, packageId })
        .once()

      console.info(
        `[addServe] ${packageId}/${interfaceId} iface:`,
        JSON.stringify({
          type: iface?.type,
          scheme: iface?.addressInfo?.scheme,
          sslScheme: iface?.addressInfo?.sslScheme,
          internalPort: iface?.addressInfo?.internalPort,
        }),
      )

      scheme = iface?.addressInfo?.scheme ?? null
      resolvedInternalPort = iface?.addressInfo?.internalPort ?? internalPort
    }

    console.info(
      `[addServe] ${packageId}/${interfaceId} resolved → scheme=${scheme}, internalPort=${resolvedInternalPort}, tailnetPort=${existing !== undefined ? existing.port : '(new)'}`,
    )

    // Determine tailnet port:
    //   1. Legacy-upgrade: reuse the existing stored port.
    //   2. User supplied a port: validate it, then use it.
    //   3. Blank: auto-assign the next sequential port.
    let port: number
    if (existing !== undefined) {
      port = existing.port
    } else if (input.port !== null && input.port !== undefined) {
      if (!isPortAvailable(serves, input.port)) {
        const blocked = [...BLOCKED_PORTS].join(', ')
        throw new Error(
          `Port ${input.port} is reserved or already in use. ` +
          `Blocked ports: ${blocked}. Choose a different port or leave blank to auto-assign.`,
        )
      }
      port = input.port
    } else {
      port = assignPort(serves)
    }

    const entry = {
      port,
      hostId,
      scheme,
      internalPort: resolvedInternalPort,
    }

    const updatedServes: z.infer<typeof servesShape> = {
      ...serves,
      [packageId]: { ...(serves[packageId] ?? {}), [interfaceId]: entry },
    }

    const mounts = sdk.Mounts.of().mountVolume({
      volumeId: 'tailscale',
      subpath: null,
      mountpoint: STATE_DIR,
      readonly: false,
    })

    await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'tailscale', sharedRun: true },
      mounts,
      'tailscale-serve-add',
      async (sub) => {
        await applyServicesConfig(sub, updatedServes)
      },
    )

    await storeJson.write(effects, { ...storeData, serves: updatedServes })
  },
)

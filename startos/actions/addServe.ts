import { z } from '@start9labs/start-sdk'
import { shape, storeJson } from '../fileModels/store.json'
import { applyServicesConfig } from '../serves'
import { sdk } from '../sdk'
import { assignPort } from '../utils'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  urlPluginMetadata: Value.hidden<{
    packageId: string
    interfaceId: string
    hostId: string
    internalPort: number
  }>(),
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

    // StartOS self-target is not supported: the node is already on the
    // tailnet by IP, and the platform has no :443 binding registered.
    if (packageId === 'startos') {
      console.warn('[addServe] ignoring startos self-target — not supported')
      return
    }

    // Use .once() to avoid "write after const" error
    const store: z.infer<typeof shape> =
      (await storeJson.read().once()) || {}

    const existing = store[packageId]?.[interfaceId]

    // Fully configured entry — nothing to do
    if (existing !== undefined && existing.hostId !== '') {
      return
    }

    // Resolve scheme from the service interface
    let scheme: string | null
    let resolvedInternalPort: number

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

    console.info(
      `[addServe] ${packageId}/${interfaceId} resolved → scheme=${scheme}, internalPort=${resolvedInternalPort}, tailnetPort=${existing !== undefined ? existing.port : '(new)'}`,
    )

    // Reuse existing port on legacy-upgrade; assign new port for fresh entry
    const port = existing !== undefined ? existing.port : assignPort(store)

    const entry = {
      port,
      hostId,
      scheme,
      internalPort: resolvedInternalPort,
    }

    const updated: z.infer<typeof shape> = {
      ...store,
      [packageId]: { ...(store[packageId] ?? {}), [interfaceId]: entry },
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
        await applyServicesConfig(sub, updated)
      },
    )

    await storeJson.write(effects, updated)
  },
)

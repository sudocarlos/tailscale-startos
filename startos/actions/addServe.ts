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
    const { packageId: rawPkgId, interfaceId } = input.urlPluginMetadata
    const packageId = rawPkgId ?? 'startos'

    const store: z.infer<typeof shape> =
      (await storeJson.read().const(effects)) || {}

    // Idempotent: if already configured, do nothing
    if (store[packageId]?.[interfaceId] !== undefined) {
      return
    }

    const port = assignPort(store)

    const updated: z.infer<typeof shape> = {
      ...store,
      [packageId]: { ...(store[packageId] ?? {}), [interfaceId]: port },
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
        await applyServicesConfig(sub, updated, effects)
      },
    )

    await storeJson.write(effects, updated)
  },
)

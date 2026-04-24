import { servesShape, storeJson } from '../fileModels/store.json'
import { applyServicesConfig } from '../serves'
import { sdk } from '../sdk'
import { z } from '@start9labs/start-sdk'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  urlPluginMetadata: Value.hidden<{
    interfaceId: string
    packageId: string | null
    hostId: string
    internalPort: number
    ssl: boolean
    public: boolean
    hostname: string
    port: number | null
    info: unknown
  }>(),
})

export const removeServe = sdk.Action.withInput(
  // id
  'remove-serve',

  // metadata
  async () => ({
    name: 'Remove Serve',
    description: 'Stop exposing this interface on your Tailscale network',
    warning: 'Confirm you would like to remove this Tailscale serve',
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

    // Use .once() to avoid "write after const" error
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
    }
    const serves: z.infer<typeof servesShape> = storeData.serves

    if (serves[packageId]?.[interfaceId] === undefined) {
      return
    }

    // Remove the entry, preserving all other packages/interfaces
    const updatedServes: z.infer<typeof servesShape> = {}
    for (const [pkg, ifaces] of Object.entries(serves)) {
      const filteredIfaces: z.infer<typeof servesShape>[string] = {}
      for (const [iface, entry] of Object.entries(ifaces)) {
        if (pkg === packageId && iface === interfaceId) continue
        filteredIfaces[iface] = entry
      }
      if (Object.keys(filteredIfaces).length > 0) {
        updatedServes[pkg] = filteredIfaces
      }
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
      'tailscale-serve-remove',
      async (sub) => {
        await applyServicesConfig(sub, updatedServes)
      },
    )

    await storeJson.write(effects, { ...storeData, serves: updatedServes })
  },
)

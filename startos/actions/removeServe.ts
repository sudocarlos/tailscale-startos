import {
  servesShape,
  storeJson,
  writeStoreJson,
  defaultStore,
} from '../fileModels/store.json'
import { applyServicesConfig } from '../serves'
import { runTailscaleUp, pollUntilLoggedIn } from '../up'
import { sdk } from '../sdk'
import { normalizePackageId } from '../utils'
import { z } from '@start9labs/start-sdk'

const STATE_DIR = '/var/lib/tailscale'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  urlPluginMetadata: Value.hidden<{
    interfaceId: string
    packageId: string
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
    const packageId = normalizePackageId(rawPkgId)

    // Use .once() to avoid "write after const" error
    const storeData = (await storeJson.read().once()) ?? defaultStore
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

    let applied = true
    await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'tailscale', sharedRun: true },
      mounts,
      'tailscale-serve-remove',
      async (sub) => {
        // Converge the daemon first so a pending login is driven forward;
        // serves can only be removed once the client is logged in.
        try {
          await runTailscaleUp(sub, storeData)
        } catch (e) {
          console.error('[removeServe] tailscale up failed:', e)
        }
        const { loggedIn } = await pollUntilLoggedIn(sub, {
          timeoutMs: 10_000,
          stopOnAuthUrl: true,
        })
        if (!loggedIn) {
          applied = false
          return
        }
        await applyServicesConfig(
          sub,
          updatedServes,
          storeData.controlServer !== null,
        )
      },
    )

    await writeStoreJson({ ...storeData, serves: updatedServes })

    if (!applied) {
      return {
        version: '1' as const,
        title: 'Serve Removed',
        message:
          'The serve entry was removed. Tailscale is not logged in, so the ' +
          'live serve state will be updated automatically once the node ' +
          'connects.',
        result: null,
      }
    }
  },
)

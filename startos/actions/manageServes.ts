import { z } from '@start9labs/start-sdk'
import { shape, storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'
import { assignPort } from '../utils'

const { InputSpec, Value, List, Variants } = sdk

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

// Path inside the subcontainer where we write the services config file
const SERVE_CONFIG_PATH = '/tmp/tailscale-serve-config.json'

export const inputSpec = InputSpec.of({
  serves: Value.list(
    List.obj(
      { name: 'Serves' },
      {
        displayAs: '{{service.selection}} - {{service.value.iface}}',
        uniqueBy: { all: ['service.selection', 'service.value.iface'] },
        spec: InputSpec.of({
          service: Value.dynamicUnion(async ({ effects }) => {
            console.log('[manageServes] dynamicUnion: start')
            const packages = await sdk.getInstalledPackages(effects)
            console.log('[manageServes] dynamicUnion: packages =', packages)

          const entries = (
            await Promise.all(
              packages.map(async (packageId) => {
                console.log('[manageServes] dynamicUnion: processing package', packageId)
                let title: string
                try {
                  title =
                    (await sdk
                      .getServiceManifest(effects, packageId, (m) => m?.title)
                      .const()) ?? packageId
                } catch (e) {
                  console.error('[manageServes] dynamicUnion: getServiceManifest error for', packageId, ':', e instanceof Error ? e.stack : String(e))
                  throw e
                }
                console.log('[manageServes] dynamicUnion: title =', title)

                let iFaces: string[][]
                try {
                  iFaces = await sdk.serviceInterface
                    .getAll(effects, { packageId }, (ifaces) =>
                      ifaces.map((i) => [i.id, i.name]),
                    )
                    .once()
                } catch (e) {
                  console.error('[manageServes] dynamicUnion: getAll error for', packageId, ':', e instanceof Error ? e.stack : String(e))
                  throw e
                }
                console.log('[manageServes] dynamicUnion: iFaces =', iFaces)

                  if (!iFaces.length) return null

                  return getSpec(packageId, title, iFaces)
                }),
              )
            ).filter((e): e is NonNullable<typeof e> => e !== null)
            console.log('[manageServes] dynamicUnion: entries =', entries)

            // z.union requires at least 2 variants; always include a disabled
            // placeholder so the union is valid even when no other packages
            // are installed.
            const allEntries = [
              getSpec('startos', 'StartOS', [['ui', 'UI']]),
              ...entries,
            ]
            if (allEntries.length < 2) {
              allEntries.push(
                getSpec('_placeholder', '— no other services —', [
                  ['none', 'none'],
                ]),
              )
            }

            return {
              name: 'Service',
              default: 'startos',
              disabled: entries.length === 0 ? ['_placeholder'] : false,
              variants: Variants.of(Object.fromEntries(allEntries)),
            }
          }),
        }),
      },
    ),
  ),
})

export const manageServes = sdk.Action.withInput(
  // id
  'manage-serves',

  // metadata
  async () => ({
    name: 'Manage Serves',
    description: 'Expose services on your Tailscale network via tailscale serve',
    warning: null,
    allowedStatuses: 'only-running',
    group: null,
    visibility: 'enabled',
  }),

  // input spec
  inputSpec,

  // pre-fill form from store
  async ({ effects }) => {
    console.log('[manageServes] prefill: start')
    let store: z.infer<typeof shape> = {}
    try {
      store = (await storeJson.read().const(effects)) || {}
      console.log('[manageServes] prefill: store =', JSON.stringify(store))
    } catch (e) {
      console.error('[manageServes] prefill: storeJson.read().const error:', e instanceof Error ? e.stack : String(e))
      throw e
    }

    return {
      serves: Object.entries(store).flatMap(([packageId, ifaces]) =>
        Object.entries(ifaces).map(([interfaceId]) => ({
          service: {
            selection: packageId,
            value: { iface: interfaceId },
          },
        })),
      ),
    }
  },

  // execution
  async ({ effects, input }) => {
    const store = (await storeJson.read().const(effects)) || {}

    // Build new desired state: preserve existing ports, assign new ones
    const toSave: z.infer<typeof shape> = {}
    const workingStore = { ...store }

    for (const serve of input.serves) {
      const { selection, value } = serve.service as {
        selection: string
        value: { iface: string }
      }
      const interfaceId = value.iface

      if (!toSave[selection]) toSave[selection] = {}

      const existingPort = store[selection]?.[interfaceId]
      const port = existingPort !== undefined ? existingPort : assignPort(workingStore)

      toSave[selection][interfaceId] = port
      if (!workingStore[selection]) workingStore[selection] = {}
      workingStore[selection][interfaceId] = port
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
      'tailscale-serve-mgr',
      async (sub) => {
        await applyServicesConfig(sub, toSave, effects)
      },
    )

    await storeJson.write(effects, toSave)
  },
)

/**
 * Builds a Tailscale Services configuration object from the store and applies
 * it atomically via `tailscale serve set-config --all`.
 *
 * For each entry, the local target protocol is determined live from the
 * service interface's addressInfo.scheme:
 *   - scheme === 'http' (or startos): `http://<host>:<port>` — Tailscale
 *     terminates TLS and reverse-proxies to the HTTP backend.
 *   - otherwise: `tcp://<host>:<port>` — raw TCP forwarding.
 */
export async function applyServicesConfig(
  sub: { exec: (cmd: string[]) => Promise<{ exitCode: number | null; stderr: Buffer | string }> },
  store: z.infer<typeof shape>,
  effects: Parameters<typeof sdk.serviceInterface.get>[0],
): Promise<void> {
  type ServicesConfig = {
    version: string
    services: Record<string, { endpoints: Record<string, string> }>
  }

  const config: ServicesConfig = { version: '0.0.1', services: {} }

  for (const [packageId, ifaces] of Object.entries(store)) {
    for (const [interfaceId, port] of Object.entries(ifaces)) {
      let host: string
      let internalPort: number
      let httpProxy: boolean

      if (packageId === 'startos') {
        host = 'startos.startos'
        internalPort = 80
        httpProxy = true
      } else {
        host = `${packageId}.startos`
        const iface = await sdk.serviceInterface
          .get(effects, { id: interfaceId, packageId })
          .once()
        if (!iface?.addressInfo) {
          console.warn(`[manageServes] no addressInfo for ${packageId}/${interfaceId}, skipping`)
          continue
        }
        internalPort = iface.addressInfo.internalPort
        httpProxy = iface.addressInfo.scheme === 'http'
      }

      const localTarget = httpProxy
        ? `http://${host}:${internalPort}`
        : `tcp://${host}:${internalPort}`

      const svcName = `svc:${packageId}-${interfaceId}`
      config.services[svcName] = {
        endpoints: { [`tcp:${port}`]: localTarget },
      }
    }
  }

  // Write config JSON to a temp file inside the subcontainer and apply it
  const configJson = JSON.stringify(config)
  const writeResult = await sub.exec([
    'sh', '-c', `printf '%s' '${configJson.replace(/'/g, "'\\''")}' > ${SERVE_CONFIG_PATH}`,
  ])
  if (writeResult.exitCode !== 0) {
    throw new Error(`Failed to write serve config: ${writeResult.stderr.toString()}`)
  }

  const applyResult = await sub.exec([
    'tailscale',
    '--socket=' + SOCKET,
    'serve',
    'set-config',
    '--all',
    SERVE_CONFIG_PATH,
  ])
  if (applyResult.exitCode !== 0) {
    throw new Error(`tailscale serve set-config --all failed: ${applyResult.stderr.toString()}`)
  }

  console.info(`[manageServes] applied services config with ${Object.keys(config.services).length} service(s)`)
}

function getSpec(packageId: string, packageTitle: string, iFaces: string[][]) {
  return [
    packageId,
    {
      name: packageTitle,
      spec: InputSpec.of({
        iface: Value.select({
          name: 'Service Interface',
          default: '',
          values: Object.fromEntries(iFaces),
        }),
      }),
    },
  ] as const
}

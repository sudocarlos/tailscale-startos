import { z } from '@start9labs/start-sdk'
import { shape, storeJson } from '../fileModels/store.json'
import { sdk } from '../sdk'
import { assignPort } from '../utils'
import { startProxy, stopProxy, proxyKey } from '../tcpProxy'

const { InputSpec, Value, List, Variants } = sdk

const STATE_DIR = '/var/lib/tailscale'
const SOCKET = '/var/run/tailscale/tailscaled.sock'

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

      const existing = store[selection]?.[interfaceId]
      if (existing !== undefined) {
        toSave[selection][interfaceId] = existing
      } else {
        // Determine if this is an HTTP service
        let httpProxy: boolean
        if (selection === 'startos') {
          httpProxy = true
        } else {
          const iface = await sdk.serviceInterface
            .get(effects, { id: interfaceId, packageId: selection })
            .once()
          httpProxy = iface?.addressInfo?.scheme === 'http'
        }

        const port = assignPort(workingStore)
        toSave[selection][interfaceId] = { port, httpProxy }
        if (!workingStore[selection]) workingStore[selection] = {}
        workingStore[selection][interfaceId] = { port, httpProxy }
      }
    }

    // Determine removals and additions
    const removals: Array<{ packageId: string; interfaceId: string; port: number; httpProxy: boolean }> = []
    const additions: Array<{ packageId: string; interfaceId: string; port: number; httpProxy: boolean; host: string; internalPort: number }> = []

    // Removals: was in store, not in toSave
    for (const [packageId, ifaces] of Object.entries(store)) {
      for (const [interfaceId, entry] of Object.entries(ifaces)) {
        if (toSave[packageId]?.[interfaceId] === undefined) {
          removals.push({ packageId, interfaceId, port: entry.port, httpProxy: entry.httpProxy })
        }
      }
    }

    // Additions: in toSave but not in store
    for (const [packageId, ifaces] of Object.entries(toSave)) {
      for (const [interfaceId, entry] of Object.entries(ifaces)) {
        if (store[packageId]?.[interfaceId] === undefined) {
          let host: string
          let internalPort: number

          if (packageId === 'startos') {
            host = 'startos.startos'
            internalPort = 80
          } else {
            host = `${packageId}.startos`
            const iface = await sdk.serviceInterface
              .get(effects, { id: interfaceId, packageId })
              .once()
            if (!iface?.addressInfo) continue
            internalPort = iface.addressInfo.internalPort
          }

          additions.push({ packageId, interfaceId, port: entry.port, httpProxy: entry.httpProxy, host, internalPort })
        }
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
      'tailscale-serve-mgr',
      async (sub) => {
        // Remove old serves
        for (const { packageId, interfaceId, port, httpProxy } of removals) {
          if (httpProxy) {
            const result = await sub.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'serve',
              '--https=' + port,
              'off',
            ])
            if (result.exitCode !== 0) {
              console.error(`tailscale serve --https=${port} off failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
            }
          } else {
            const result = await sub.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'serve',
              '--tcp=' + port,
              'off',
            ])
            if (result.exitCode !== 0) {
              console.error(`tailscale serve --tcp=${port} off failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
            }
            await stopProxy(proxyKey(packageId, interfaceId))
          }
        }

        // Add new serves
        for (const { packageId, interfaceId, port, httpProxy, host, internalPort } of additions) {
          if (httpProxy) {
            // Native HTTPS reverse proxy — no TCP proxy needed
            const result = await sub.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'serve',
              '--bg',
              '--https=' + port,
              `http://${host}:${internalPort}`,
            ])
            if (result.exitCode !== 0) {
              throw new Error(`tailscale serve --https=${port} http://${host}:${internalPort} failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
            }
          } else {
            // TCP proxy: 127.0.0.1:<port> -> <host>:<internalPort>
            const key = proxyKey(packageId, interfaceId)
            await startProxy(key, port, host, internalPort)

            const result = await sub.exec([
              'tailscale',
              '--socket=' + SOCKET,
              'serve',
              '--bg',
              '--tcp=' + port,
              `tcp://localhost:${port}`,
            ])
            if (result.exitCode !== 0) {
              throw new Error(`tailscale serve --tcp=${port} tcp://localhost:${port} failed (exit ${result.exitCode}): ${result.stderr.toString()}`)
            }
          }
        }
      },
    )

    await storeJson.write(effects, toSave)
  },
)

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

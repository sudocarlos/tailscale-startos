import { servesShape, storeJson } from '../fileModels/store.json'
import { applyServicesConfig } from '../serves'
import { sdk } from '../sdk'
import {
  assignFunnelPort,
  assignPort,
  assertFunnelPort,
  FUNNEL_ALLOWED_PORTS,
  isPortAvailable,
  BLOCKED_PORTS,
} from '../utils'
import { z } from '@start9labs/start-sdk'

const STATE_DIR = '/var/lib/tailscale'

const FUNNEL_WARNING =
  'While Serve stays private to your tailnet, Funnel makes your service public. ' +
  'Exposing apps to the open internet carries inherent security risks, opening ' +
  'them up to bot traffic and public vulnerabilities. ' +
  'See https://tailscale.com/docs/features/tailscale-funnel for details.'

const { InputSpec, Value } = sdk

const inputSpec = InputSpec.of({
  urlPluginMetadata: Value.hidden<{
    packageId: string
    interfaceId: string
    hostId: string
    internalPort: number
  }>(),
  mode: Value.select({
    name: 'Serve Mode',
    description:
      'While Serve stays private to your tailnet, Funnel makes your service public. ' +
      'Exposing apps to the open internet carries inherent security risks, opening ' +
      'them up to bot traffic and public vulnerabilities. ' +
      'See https://tailscale.com/docs/features/tailscale-funnel for details.\n\n' +
      'Funnel must be enabled for your tailnet in the Tailscale admin console ' +
      'and is restricted to ports 443, 8443, and 10000 only.',
    default: 'serve' as 'serve' | 'funnel',
    values: {
      serve: 'Tailscale Serve (tailnet-only, any port)',
      funnel: 'Funnel (PUBLIC internet — ports 443 / 8443 / 10000 only)',
    },
  }),
  port: Value.number({
    name: 'Tailnet Port',
    description:
      'Port to expose on your Tailscale network. For Funnel, must be 443, 8443, or 10000. ' +
      'Leave blank to auto-assign.',
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
    description:
      'Expose this interface on your Tailscale network via Tailscale Serve or Funnel.',
    warning:
      'Tailscale Serve is tailnet-only. ' +
      'If you select Funnel mode this service will be visible to anyone on the ' +
      'public internet — not just your tailnet. ' +
      FUNNEL_WARNING,
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
    const mode: 'serve' | 'funnel' = input.mode ?? 'serve'

    // Use .once() to avoid "write after const" error
    const storeData = (await storeJson.read().once()) ?? {
      machineName: 'startos',
      hostnameSet: false,
      serves: {},
      authKey: null,
    }
    const serves: z.infer<typeof servesShape> = storeData.serves

    const existing = serves[packageId]?.[interfaceId]

    console.info(
      `[addServe] ${packageId}/${interfaceId} mode=${mode} existing:`,
      JSON.stringify(existing ?? null),
    )

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

    // Determine tailnet port — logic differs by mode.
    let port: number

    if (mode === 'funnel') {
      // ── Funnel port resolution ──────────────────────────────────────────
      // Funnel only permits ports 443, 8443, and 10000.
      if (input.port !== null && input.port !== undefined) {
        assertFunnelPort(input.port)
        // Check for conflicts against other entries (excluding this one).
        const servesWithoutThis = {
          ...serves,
          [packageId]: { ...(serves[packageId] ?? {}) },
        }
        delete servesWithoutThis[packageId][interfaceId]
        const allOtherPorts = Object.values(servesWithoutThis).flatMap(
          (ifaces) => Object.values(ifaces).map((e) => e.port),
        )
        if (allOtherPorts.includes(input.port)) {
          throw new Error(
            `Port ${input.port} is already in use by another serve entry. ` +
            `Remove the existing entry first or choose a different Funnel port ` +
            `(${FUNNEL_ALLOWED_PORTS.join(', ')}).`,
          )
        }
        port = input.port
      } else if (existing !== undefined && existing.mode === 'funnel' && existing.hostId !== '') {
        // Preserve the stored funnel port for fully-configured existing entries.
        port = existing.port
      } else {
        // Auto-assign the first free funnel port: 443 → 8443 → 10000.
        port = assignFunnelPort(serves)
      }
    } else {
      // ── Serve port resolution (existing logic) ──────────────────────────
      if (input.port !== null && input.port !== undefined) {
        // Exclude the existing entry's own port from the "in use" check so the
        // user can re-submit without being blocked by their own port.
        const servesWithoutThis = {
          ...serves,
          [packageId]: { ...(serves[packageId] ?? {}) },
        }
        delete servesWithoutThis[packageId][interfaceId]
        if (!isPortAvailable(servesWithoutThis, input.port)) {
          const blocked = [...BLOCKED_PORTS].join(', ')
          throw new Error(
            `Port ${input.port} is reserved or already in use. ` +
            `Blocked ports: ${blocked}. Choose a different port or leave blank to auto-assign.`,
          )
        }
        port = input.port
      } else if (existing !== undefined && existing.hostId !== '' && existing.mode !== 'funnel') {
        // Preserve the stored port for fully-configured existing serve entries.
        port = existing.port
      } else {
        port = assignPort(serves)
      }
    }

    console.info(
      `[addServe] ${packageId}/${interfaceId} resolved → mode=${mode}, scheme=${scheme}, ` +
      `internalPort=${resolvedInternalPort}, port=${port}`,
    )

    const entry = {
      port,
      hostId,
      scheme,
      internalPort: resolvedInternalPort,
      mode,
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

    // ── Result message ─────────────────────────────────────────────────────
    // Layer 3 warning: shown only when the user confirmed Funnel mode.
    if (mode === 'funnel') {
      return {
        version: '1' as const,
        title: 'Funnel Added',
        message:
          `This service is now publicly accessible on the internet via Tailscale ` +
          `Funnel on port ${port}. ` +
          FUNNEL_WARNING +
          ' To remove public access, click the Tailscale icon on this service\'s ' +
          'URL row and choose Remove Serve.',
        result: null,
      }
    }
  },
)

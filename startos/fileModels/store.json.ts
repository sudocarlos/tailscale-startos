import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

/**
 * Per-interface entry stored in store.json.
 *
 * `hostId === ''` is the sentinel for legacy entries (migrated from bare
 * numbers or `{port,httpProxy}` objects).  Such entries are kept so we can
 * preserve the assigned tailnet port across upgrades, but they are skipped
 * during URL export and serve restoration until the user re-clicks "Add Serve"
 * to supply the full metadata.
 */
export const storeEntry = z.object({
  /** Assigned tailnet HTTPS port for this serve. */
  port: z.number().int().min(1).max(65535),
  /**
   * Real hostId from urlPluginMetadata.  Empty string means this is a legacy
   * entry that has not yet been upgraded by the user.
   */
  hostId: z.string(),
  /**
   * Upstream scheme as returned by addressInfo.scheme, or null for TCP
   * passthrough.  Supported values:
   *   'http' | 'ws'          → http proxy (HTTP upstream)
   *   'https' | 'wss'        → http proxy (HTTPS upstream, skip verify)
   *   'ssh' | 'dns' | null   → TCP passthrough
   * Any unrecognised string is also treated as TCP passthrough.
   * null on legacy entries.
   */
  scheme: z.string().nullable(),
  /** Port the upstream service listens on.  0 on legacy entries. */
  internalPort: z.number().int().min(0).max(65535),
})

export type StoreEntry = z.infer<typeof storeEntry>

// Sentinel value written for legacy entries so we remember the port.
const legacySentinel = (port: number): StoreEntry => ({
  port,
  hostId: '',
  scheme: null,
  internalPort: 0,
})

/** Shape of the serves sub-map: { [packageId]: { [interfaceId]: StoreEntry } } */
export const servesShape = z.record(
  z.string(),
  z.record(
    z.string(),
    // Accept three legacy variants and coerce them all to the new shape.
    z.union([
      // New full object — passthrough.
      storeEntry,
      // Old { port, httpProxy } object.
      z
        .object({
          port: z.number().int().min(1).max(65535),
          httpProxy: z.boolean(),
        })
        .transform((e) => legacySentinel(e.port)),
      // Bare port number.
      z
        .number()
        .int()
        .min(1)
        .max(65535)
        .transform((n) => legacySentinel(n)),
    ]),
  ),
)

/**
 * Top-level store shape.
 *
 * `machineName` — the Tailscale machine/hostname to advertise.  Defaults to
 *   'startos' and is set by the user via the Set Machine Name action before
 *   the service starts for the first time.
 *
 * `hostnameSet` — true once the startup oneshot has successfully applied
 *   the machine name via `tailscale set --hostname`.  Prevents redundant
 *   re-application on every restart after the initial set.
 *
 * `serves` — the per-package/interface serve port-mapping table (the entire
 *   former top-level shape, now nested).
 *
 * `authKey` — a Tailscale auth key (tskey-auth-...) submitted via the Get
 *   Started action while the container was stopped.  It is passed to
 *   `tailscaled` as the `TS_AUTH_KEY` environment variable on next start and
 *   cleared from the store once the node reaches BackendState=Running so it
 *   is never reused across restarts.
 *
 * A z.union is used to accept the legacy top-level serves format (from
 * before the store was refactored) and migrate it transparently so that
 * existing installs don't break on upgrade.
 */
const currentShape = z.object({
  machineName: z.string().default('startos'),
  hostnameSet: z.boolean().default(false),
  serves: servesShape.default({}),
  authKey: z.string().nullable().default(null),
})

export const shape = z
  .union([servesShape, currentShape])
  .transform((value) =>
    'serves' in value
      ? (value as z.infer<typeof currentShape>)
      : {
          machineName: 'startos',
          hostnameSet: false,
          serves: value as z.infer<typeof servesShape>,
          authKey: null,
        },
  )

export type Store = z.infer<typeof currentShape>

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/store.json',
  },
  shape,
)

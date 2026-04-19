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
   * Upstream scheme ('http' | 'https') or null for TCP passthrough.
   * null on legacy entries.
   */
  scheme: z.enum(['http', 'https']).nullable(),
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

// shape: { [packageId]: { [interfaceId]: StoreEntry } }
export const shape = z.record(
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

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/store.json',
  },
  shape,
)

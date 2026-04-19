import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const entryShape = z.object({
  port: z.number().int().min(1).max(65535),
  httpProxy: z.boolean(),
})

// Accept legacy bare-number entries (port only, pre-schema) and coerce them
// to { port, httpProxy: false } so reads never fail on old store data.
// httpProxy is always re-detected on the next Manage Serves save.
const entryShapeCoerced = z.union([
  entryShape,
  z.number().int().min(1).max(65535).transform((port) => ({ port, httpProxy: false })),
])

// shape: { [packageId]: { [interfaceId]: { port, httpProxy } } }
export const shape = z.record(z.string(), z.record(z.string(), entryShapeCoerced))

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/store.json',
  },
  shape,
)

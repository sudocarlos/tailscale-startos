import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const entryShape = z.object({
  port: z.number().int().min(1).max(65535),
  httpProxy: z.boolean(),
})

// shape: { [packageId]: { [interfaceId]: { port, httpProxy } } }
export const shape = z.record(z.string(), z.record(z.string(), entryShape))

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/store.json',
  },
  shape,
)

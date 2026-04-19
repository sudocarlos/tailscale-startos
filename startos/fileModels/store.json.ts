import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// shape: { [packageId]: { [interfaceId]: port } }
// Tracks assigned tailnet ports for stable port reuse across saves.
export const shape = z.record(
  z.string(),
  z.record(
    z.string(),
    // Accept legacy { port, httpProxy } objects from prior schema versions
    // and coerce them to a plain port number.
    z.union([
      z.number().int().min(1).max(65535),
      z.object({ port: z.number().int().min(1).max(65535), httpProxy: z.boolean() })
        .transform((e) => e.port),
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

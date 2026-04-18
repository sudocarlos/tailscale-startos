import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// shape: { [packageId]: { [interfaceId]: tailnetPort } }
export const shape = z.record(z.string(), z.record(z.string(), z.number().int().min(1).max(65535)))

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/store.json',
  },
  shape,
)

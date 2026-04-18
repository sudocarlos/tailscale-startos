import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const statusShape = z.object({
  ip: z.string(),
  dnsName: z.string(),
})

export const statusJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/status.json',
  },
  statusShape,
)

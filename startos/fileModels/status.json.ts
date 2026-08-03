import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { atomicWriteFile } from './atomicWrite'

export const statusShape = z.object({
  ip: z.string(),
  dnsName: z.string(),
})

export type Status = z.infer<typeof statusShape>

const PATH = sdk.volumes.startos.subpath('/status.json')

export const statusJson = FileHelper.json(
  {
    base: sdk.volumes.startos,
    subpath: '/status.json',
  },
  statusShape,
)

/**
 * Validates and atomically replaces status.json.  All writes must go through
 * this rather than `statusJson.write` — see atomicWrite.ts for why.
 */
export async function writeStatusJson(data: Status): Promise<null> {
  await atomicWriteFile(PATH, JSON.stringify(statusShape.parse(data), null, 2))
  return null
}

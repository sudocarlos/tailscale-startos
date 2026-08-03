import * as fs from 'node:fs/promises'

/**
 * Atomically replaces the file at `path` by writing a sibling temp file and
 * renaming it over the target.
 *
 * FileHelper writes are plain writeFile(2): a FileHelper `.const()` watcher
 * reacting to the write's own fs event can observe a truncated file and throw
 * on JSON.parse — an error that permanently kills the watcher's subscription
 * (leaving URL tiles frozen until the service restarts).  rename(2) is atomic
 * on POSIX, so readers only ever see complete files.
 */
export async function atomicWriteFile(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
}

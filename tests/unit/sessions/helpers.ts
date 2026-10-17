// Shared by the sessions tests: zips of player files, written with yazl.
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'

/** Writes a zip holding `entries` (a name ending with `/` is a folder) and returns its path. */
export async function makeZip(file: string, entries: Record<string, string | Buffer>): Promise<string> {
  const zip = new ZipFile()
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) zip.addEmptyDirectory(name)
    else zip.addBuffer(Buffer.from(data), name)
  }
  zip.end()
  mkdirSync(dirname(file), { recursive: true })
  await pipeline(zip.outputStream, createWriteStream(file))
  return file
}

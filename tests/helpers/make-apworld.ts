// Builds .apworld files for the tests with yazl: a zip holding `<module>/__init__.py` and, unless told
// otherwise, the `<module>/archipelago.json` that Archipelago's "Build APWorlds" component writes.
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'

/** A valid packaged manifest (`version` and `compatible_version` 7, as Archipelago 0.6.8 writes them). */
export function apworldManifest(game: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { game, version: 7, compatible_version: 7, ...fields }
}

export interface MakeApworldOptions {
  /** The root folder, i.e. the module name. Default: the file stem. */
  module?: string
  /** The game of the default manifest. Default: the module. */
  game?: string
  /** archipelago.json: an object (written as JSON), raw text, or null for none. Default: `apworldManifest(game)`. */
  manifest?: Record<string, unknown> | string | null
  /** Where archipelago.json goes. Default: 'module' (`<module>/archipelago.json`). */
  manifestAt?: 'root' | 'module'
  /** Whether `<module>/__init__.py` is written. Default: true. */
  init?: boolean
  /** More entries, by path inside the zip. */
  files?: Record<string, string | Buffer>
}

/** Writes the .apworld at `file` (its folder is created) and returns `file`. */
export async function makeApworld(file: string, opts: MakeApworldOptions = {}): Promise<string> {
  const module = opts.module ?? basename(file).replace(/\.apworld$/i, '')
  const zip = new ZipFile()
  if (opts.init ?? true) zip.addBuffer(Buffer.from('from .world import *\n'), `${module}/__init__.py`)
  const manifest = opts.manifest === undefined ? apworldManifest(opts.game ?? module) : opts.manifest
  if (manifest !== null) {
    const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    zip.addBuffer(
      Buffer.from(text),
      opts.manifestAt === 'root' ? 'archipelago.json' : `${module}/archipelago.json`,
    )
  }
  for (const [name, data] of Object.entries(opts.files ?? {})) zip.addBuffer(Buffer.from(data), name)
  zip.end()
  mkdirSync(dirname(file), { recursive: true })
  await pipeline(zip.outputStream, createWriteStream(file))
  return file
}

/** Renames entries in place (same length), to build the names yazl would never write (`..`). */
export function patchZipNames(file: string, from: string, to: string): void {
  if (from.length !== to.length) throw new Error('names must have the same length')
  writeFileSync(file, Buffer.from(readFileSync(file).toString('latin1').replaceAll(from, to), 'latin1'))
}

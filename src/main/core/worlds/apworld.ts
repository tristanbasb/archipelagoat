// Static inspection of an .apworld (spec §3.9): the zip is read with limits and path checks, and
// nothing in it is ever run. The checks are those of Archipelago's "Install APWorld"
// (LauncherComponents.py:135-214) and the manifest rules of worlds/Files.py (APWorldContainer).
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { listZip, readZipText, sha256File } from '@main/core/system/archive'
import { AppError } from '@shared/errors'
import type { WorldManifest } from '@shared/types'

/** worlds/Files.py `container_version`: a manifest whose `compatible_version` is higher is refused. */
export const AP_CONTAINER_VERSION = 7

export interface ApworldInspection {
  /** The single root folder, i.e. the Python module Archipelago imports. */
  module: string
  hasInit: boolean
  /** null when there is no usable manifest (none, not JSON, no game); see `manifestError`. */
  manifest: WorldManifest | null
  /**
   * Why Archipelago would refuse the manifest (`missing`, `invalid-json`, `not-an-object`,
   * `invalid-game`, `missing-compatible_version`, `compatible-version-too-new`, `invalid-<key>`), or
   * null. A refused manifest is only a warning before 0.7.0, and fatal from 0.7.0 (brief §1.10).
   */
  manifestError: string | null
  sha256: string
  sizeBytes: number
}

/** What an archive holds, before any judgement on its structure (the inventory reads worlds as is). */
export interface ApworldContents {
  /** Top-level folders, in archive order. */
  roots: string[]
  /** The roots that hold an `__init__.py`. */
  initRoots: string[]
  manifest: WorldManifest | null
  manifestError: string | null
  /**
   * Without a manifest game: the `game` its World class declares in the module's top-level Python
   * files, read as text (gameFromSource); null when none says.
   */
  sourceGame: string | null
}

export type WorldInvalidReason =
  'not-zip' | 'zip-bomb' | 'traversal' | 'multiple-roots' | 'no-init' | 'name-mismatch'

const invalid = (reason: WorldInvalidReason, detail?: string): AppError =>
  new AppError('WORLD_INVALID', { reason }, detail === undefined ? {} : { detail })

const VERSION = /^\d+\.\d+\.\d+$/
const MANIFEST = 'archipelago.json'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads an archipelago.json as Archipelago does. `packaged` (an .apworld, the default) also requires
 * `compatible_version`, at most `AP_CONTAINER_VERSION`; a folder world needs its `game` only. The
 * manifest is null when it cannot be used at all; otherwise `error` names the first field
 * Archipelago would refuse.
 */
export function parseWorldManifest(
  text: string | null,
  opts: { packaged?: boolean } = {},
): { manifest: WorldManifest | null; error: string | null } {
  if (text === null) return { manifest: null, error: 'missing' }
  let data: unknown
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return { manifest: null, error: 'invalid-json' }
  }
  if (!isPlainObject(data)) return { manifest: null, error: 'not-an-object' }
  const { game } = data
  if (typeof game !== 'string' || game.trim() === '') return { manifest: null, error: 'invalid-game' }

  const errors: string[] = []
  const version = (key: string): string | null => {
    const value = data[key]
    if (value === undefined) return null
    if (typeof value === 'string' && VERSION.test(value)) return value
    errors.push(`invalid-${key}`)
    return null
  }
  const integer = (key: string): number | null => {
    const value = data[key]
    return typeof value === 'number' && Number.isInteger(value) ? value : null
  }
  const authors = Array.isArray(data.authors)
    ? data.authors.filter((a): a is string => typeof a === 'string')
    : typeof data.authors === 'string'
      ? [data.authors]
      : []

  const manifest: WorldManifest = {
    game,
    worldVersion: version('world_version'),
    minimumApVersion: version('minimum_ap_version'),
    maximumApVersion: version('maximum_ap_version'),
    authors,
    version: integer('version'),
    compatibleVersion: integer('compatible_version'),
  }
  if (opts.packaged ?? true) {
    if (data.compatible_version === undefined) errors.unshift('missing-compatible_version')
    else if (manifest.compatibleVersion === null) errors.unshift('invalid-compatible_version')
    else if (manifest.compatibleVersion > AP_CONTAINER_VERSION) errors.unshift('compatible-version-too-new')
  }
  return { manifest, error: errors[0] ?? null }
}

/** A World class: `class TunicWorld(World):`, with any base whose name ends with `World` (not WebWorld). */
const WORLD_CLASS = /^class[ \t]+\w+[ \t]*\(([^)]*)\)[ \t]*:/gm
/** `game = "X"`, `game: str = 'X'`, `game: ClassVar[str] = "X"`, indented in a class body. */
const GAME_ATTRIBUTE = /^[ \t]+game[ \t]*(?::[^=\r\n]*)?=[ \t]*[rRuU]?(["'])((?:(?!\1)[^\\\r\n])+)\1/m
/** The top-level Python files read for a World class, and the bytes read of each. */
const MAX_SOURCE_FILES = 32
const MAX_SOURCE_BYTES = 1024 * 1024

/**
 * The `game` a World class of `source` declares, read as text (nothing runs): the first class
 * deriving from a `…World` base other than WebWorld, then the first `game = '…'` of its body. Null when
 * the source declares none. Archipelago 0.6 loads worlds without a manifest; this is how such a
 * world's game is known.
 */
export function gameFromSource(source: string): string | null {
  const text = source.replaceAll('\r\n', '\n')
  for (const match of text.matchAll(WORLD_CLASS)) {
    const bases = (match[1] ?? '').split(',').map((base) => base.trim().split('.').pop() ?? '')
    if (!bases.some((base) => base.endsWith('World') && base !== 'WebWorld')) continue
    const start = (match.index ?? 0) + match[0].length
    // The class body: up to the next line that is neither blank, indented nor a comment.
    const rest = text.slice(start)
    const end = rest.search(/\n(?=[^\s#])/)
    const body = end === -1 ? rest : rest.slice(0, end)
    const game = GAME_ATTRIBUTE.exec(body)?.[2]?.trim()
    if (game) return game
  }
  return null
}

/** `__init__.py` first, then the module's other top-level Python files, by name. */
export function sourceFilesOf(module: string, names: readonly string[]): string[] {
  const prefix = `${module}/`
  const top = names.filter(
    (name) => name.startsWith(prefix) && name.endsWith('.py') && !name.slice(prefix.length).includes('/'),
  )
  const init = `${prefix}__init__.py`
  return [...top.filter((n) => n === init), ...top.filter((n) => n !== init).sort()].slice(
    0,
    MAX_SOURCE_FILES,
  )
}

/** The game the module's code declares, from `read` (an entry's text, or null). */
export async function gameFromModule(
  files: readonly string[],
  read: (file: string) => Promise<string | null>,
): Promise<string | null> {
  for (const file of files) {
    const text = await read(file).catch(() => null)
    const game = text === null ? null : gameFromSource(text)
    if (game !== null) return game
  }
  return null
}

/**
 * Lists the archive and reads its manifest: `archipelago.json` at the root, else the first entry
 * whose name ends with it (APContainer.read_contents). Without a manifest game, the game its code
 * declares (`sourceGame`). Throws `WORLD_INVALID` (`not-zip`, `zip-bomb`, `traversal`) for an archive
 * that cannot be read safely, `NOT_FOUND` for a missing file.
 */
export async function readApworld(file: string): Promise<ApworldContents> {
  const entries = await listZip(file)
  const names = entries.filter((e) => !e.isDir).map((e) => e.name)
  const roots: string[] = []
  for (const { name } of entries) {
    const slash = name.indexOf('/')
    const top = slash === -1 ? null : name.slice(0, slash)
    if (top !== null && !roots.includes(top)) roots.push(top)
  }
  const initRoots = roots.filter((root) => names.includes(`${root}/__init__.py`))
  const manifestName = names.includes(MANIFEST) ? MANIFEST : names.find((n) => n.endsWith(MANIFEST))
  const text = manifestName === undefined ? null : await readZipText(file, manifestName)
  const { manifest, error } = parseWorldManifest(text)
  const [root] = initRoots
  const sourceGame =
    manifest === null && initRoots.length === 1 && root !== undefined
      ? await gameFromModule(sourceFilesOf(root, names), (entry) =>
          readZipText(file, entry, MAX_SOURCE_BYTES),
        )
      : null
  return { roots, initRoots, manifest, manifestError: error, sourceGame }
}

// Characters and names Windows cannot use in a file name, or turns into something else.
const BAD_CHARS = /[<>:"|?*\\/\p{Cc}]/u
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|\s|$)/i

/** Whether every OS can create a file of that name (one path component). */
export const isPortableFileName = (name: string): boolean =>
  name !== '' && !BAD_CHARS.test(name) && !DEVICE.test(name) && !/[. ]$/.test(name)

/**
 * Whether `<module>.apworld` is a file name every OS can create and that Archipelago's scan picks up
 * (it skips names starting with `_` or `.`).
 */
export const isSafeModule = (module: string): boolean => isPortableFileName(module) && !/^[_.]/.test(module)

/** `foo-v1.2.apworld` → `foo-v1.2` (Python's Path.stem). */
const fileStem = (file: string): string => path.parse(file).name

/**
 * Inspects an .apworld before it is installed. Throws `WORLD_INVALID` with `reason`: `not-zip`,
 * `zip-bomb`, `traversal` (also for a root folder that cannot be a file name, or that Archipelago's
 * scan would skip), `multiple-roots` (more
 * than one top-level folder), `no-init` (no `<module>/__init__.py`), `name-mismatch` (the file stem
 * does not hold the folder name, case included); `NOT_FOUND` when the file does not exist.
 */
export async function inspectApworld(file: string): Promise<ApworldInspection> {
  let sizeBytes: number
  try {
    sizeBytes = (await stat(file)).size
  } catch (error) {
    throw new AppError('NOT_FOUND', undefined, { detail: file, cause: error })
  }
  const { roots, initRoots, manifest, manifestError } = await readApworld(file)
  if (roots.length > 1) throw invalid('multiple-roots', roots.join(', '))
  const [module] = roots
  if (module === undefined) throw invalid('no-init', 'no root folder')
  if (!isSafeModule(module)) throw invalid('traversal', module)
  if (!initRoots.includes(module)) throw invalid('no-init', `${module}/__init__.py`)
  if (!fileStem(file).includes(module)) throw invalid('name-mismatch', `${module} in ${path.basename(file)}`)
  return { module, hasInit: true, manifest, manifestError, sha256: await sha256File(file), sizeBytes }
}

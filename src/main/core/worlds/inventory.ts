// Inventory of the installed worlds, and a prediction of the one Archipelago loads for each game
// (spec §3.9). The scan follows worlds/__init__.py of Archipelago 0.6.8 (brief §1.10): the top level
// of each folder only, names starting with `_` or `.` skipped, folders only with an `__init__.py`,
// files only when they end with `.apworld`.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import pLimit from 'p-limit'
import { coreWorldsFor } from '@shared/data/core-worlds'
import { AppError } from '@shared/errors'
import type { ApPaths, WorldInfo, WorldManifest, WorldState } from '@shared/types'
import { parseWorldManifest, readApworld } from './apworld'

/** Where disabled worlds wait, out of the folders Archipelago scans. */
export const disabledWorldsDir = (dataRoot: string): string => path.join(dataRoot, 'disabled-worlds')

/** A world's id: the SHA-1 of its absolute path. */
export const worldId = (absolutePath: string): string => createHash('sha1').update(absolutePath).digest('hex')

const SCAN_CONCURRENCY = 8
const APWORLD = '.apworld'

type Version = [number, number, number]

/** `0.6.8`, `v0.6.8` or `0.6.8-rc1` → [0, 6, 8]; null for anything else. */
function parseVersion(version: string | null): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * The bounds a manifest sets that `apVersion` is outside of, as Archipelago checks them: null when
 * the version fits, or when either version is unknown.
 */
export function apRangeViolation(
  manifest: WorldManifest | null,
  apVersion: string | null,
): { min: string | null; max: string | null } | null {
  const installed = parseVersion(apVersion)
  if (!manifest || !installed) return null
  const min = parseVersion(manifest.minimumApVersion)
  const max = parseVersion(manifest.maximumApVersion)
  const tooOld = min !== null && compareVersions(min, installed) > 0
  const tooNew = max !== null && compareVersions(max, installed) < 0
  return tooOld || tooNew ? { min: manifest.minimumApVersion, max: manifest.maximumApVersion } : null
}

/** A world folder, as opposed to an .apworld: loaded before every .apworld, never replaceable. */
const isLoose = (world: WorldInfo): boolean => !world.fileName.endsWith(APWORLD)

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Archipelago lists the user folder first, with absolute paths that sort before core names. */
const LOCATION_RANK: Record<WorldInfo['location'], number> = { custom: 0, core: 1, disabled: 2 }

const loadOrder = (a: WorldInfo, b: WorldInfo): number =>
  LOCATION_RANK[a.location] - LOCATION_RANK[b.location] || byCodePoint(a.fileName, b.fileName)

const ZERO: Version = [0, 0, 0]

/** The highest world_version first (none counts as 0.0.0); a tie keeps Archipelago's own order. */
const versionOrder = (a: WorldInfo, b: WorldInfo): number =>
  compareVersions(
    parseVersion(b.manifest?.worldVersion ?? null) ?? ZERO,
    parseVersion(a.manifest?.worldVersion ?? null) ?? ZERO,
  ) || loadOrder(a, b)

const STATE_ORDER: WorldState[] = ['core-loose', 'no-manifest', 'incompatible', 'shadowed']

/**
 * The states of each world (pure; the input is not changed). Only `corrupt` is taken from the input:
 * the zip could not be read, which only a scan can tell. The other states are computed:
 * - `disabled` for a world in the disabled folder, alone: Archipelago does not see it;
 * - `corrupt`, alone: Archipelago stops on it, whatever the rest;
 * - `core-loose` for a core world folder, which nothing can replace;
 * - `no-manifest` for a custom .apworld whose manifest Archipelago refuses;
 * - `incompatible` when `apVersion` is outside the manifest's [min, max];
 * - `shadowed` when the game is already provided: by a loose world (loaded first), or by a higher
 *   world_version (a tie goes to the custom world).
 */
export function computeStates(worlds: readonly WorldInfo[], apVersion: string | null): WorldInfo[] {
  const entries = worlds.map((world) => ({ world, states: new Set<WorldState>() }))
  const active: typeof entries = []
  for (const entry of entries) {
    const { world, states } = entry
    if (world.location === 'disabled') states.add('disabled')
    else if (world.states.includes('corrupt')) states.add('corrupt')
    else if (isLoose(world)) {
      if (world.location === 'core') states.add('core-loose')
      active.push(entry)
    } else {
      if (world.manifest === null && world.location === 'custom') states.add('no-manifest')
      if (apRangeViolation(world.manifest, apVersion)) states.add('incompatible')
      else active.push(entry)
    }
  }

  // Loose worlds load first, core ones before custom ones; then the .apworlds, highest version
  // first. A world without manifest still loads, but its class cannot register a game twice.
  const loose = active
    .filter(({ world }) => isLoose(world))
    .sort(
      (a, b) =>
        LOCATION_RANK[b.world.location] - LOCATION_RANK[a.world.location] || loadOrder(a.world, b.world),
    )
  const packed = active.filter(({ world }) => !isLoose(world)).sort((a, b) => versionOrder(a.world, b.world))
  const provided = new Set<string>()
  for (const { world, states } of [...loose, ...packed]) {
    if (world.game === null) continue
    if (provided.has(world.game)) states.add('shadowed')
    else provided.add(world.game)
  }

  return entries.map(({ world, states }) => {
    const exclusive = (['disabled', 'corrupt'] as const).find((state) => states.has(state))
    const list = exclusive ? [exclusive] : STATE_ORDER.filter((state) => states.has(state))
    return { ...world, states: list.length > 0 ? list : ['ok'] }
  })
}

interface Candidate {
  location: WorldInfo['location']
  dir: string
  name: string
  isDir: boolean
  size: number
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then(
    (info) => info.isFile(),
    () => false,
  )
}

/** What Archipelago would pick up in `dir` (the disabled folder holds .apworld files only). */
async function listCandidates(dir: string, location: WorldInfo['location']): Promise<Candidate[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const candidates: Candidate[] = []
  for (const name of names.sort(byCodePoint)) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const info = await stat(full).catch(() => null)
    if (info?.isDirectory() && location !== 'disabled') {
      const init =
        (await isFile(path.join(full, '__init__.py'))) || (await isFile(path.join(full, '__init__.pyc')))
      if (init) candidates.push({ location, dir, name, isDir: true, size: 0 })
    } else if (info?.isFile() && name.endsWith(APWORLD)) {
      candidates.push({ location, dir, name, isDir: false, size: info.size })
    }
  }
  return candidates
}

/** One world as found on disk; null when the file vanished meanwhile. */
async function readCandidate(
  candidate: Candidate,
  coreGames: ReadonlyMap<string, string>,
): Promise<WorldInfo | null> {
  const { location, dir, name, isDir, size } = candidate
  const file = path.join(dir, name)
  const base: WorldInfo = {
    id: worldId(file),
    fileName: name,
    path: file,
    location,
    module: isDir ? name : name.slice(0, -APWORLD.length),
    game: null,
    manifest: null,
    states: [],
    sizeBytes: size,
  }
  const tableGame = location === 'core' ? (coreGames.get(base.module) ?? null) : null

  if (isDir) {
    const text = await readFile(path.join(file, 'archipelago.json'), 'utf8').catch(() => null)
    const { manifest, error } = parseWorldManifest(text, { packaged: false })
    return { ...base, game: manifest?.game ?? tableGame, manifest: error === null ? manifest : null }
  }
  try {
    const { roots, manifest, manifestError } = await readApworld(file)
    const [root] = roots
    return {
      ...base,
      module: roots.length === 1 && root !== undefined ? root : base.module,
      game: manifest?.game ?? tableGame,
      manifest: manifestError === null ? manifest : null,
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null
    // Not a zip, or one that cannot be read safely: Archipelago stops on it (BadZipFile).
    return { ...base, game: tableGame, states: ['corrupt'] }
  }
}

/** The core worlds of a version, when Archipelago's folder cannot be read (an AppImage). */
function tableWorlds(apVersion: string | null): WorldInfo[] {
  const table = apVersion === null ? null : coreWorldsFor(apVersion)
  return (table ?? [])
    .map((world) => ({
      id: worldId(`core:${world.module}`),
      fileName: world.loose ? world.module : `${world.module}${APWORLD}`,
      path: '',
      location: 'core' as const,
      module: world.module,
      game: world.game,
      manifest: null,
      states: [],
      sizeBytes: 0,
    }))
    .sort((a, b) => byCodePoint(a.fileName, b.fileName))
}

/**
 * Every world of `customWorlds`, `coreWorlds` and `disabledDir`, in that order, with its states. When
 * `paths.coreWorlds` is '' (an AppImage), the core worlds come from the table of `apVersion`, with an
 * empty `path` and the id of `core:<module>`.
 */
export async function scanWorlds(
  paths: ApPaths,
  disabledDir: string,
  apVersion: string | null,
): Promise<WorldInfo[]> {
  const coreGames = new Map(
    (apVersion === null ? null : coreWorldsFor(apVersion))?.map((w) => [w.module, w.game]),
  )
  const folders: [string, WorldInfo['location']][] = [
    [paths.customWorlds, 'custom'],
    ...(paths.coreWorlds === '' ? [] : [[paths.coreWorlds, 'core'] as [string, 'core']]),
    [disabledDir, 'disabled'],
  ]
  const candidates = (
    await Promise.all(folders.map(([dir, location]) => listCandidates(dir, location)))
  ).flat()
  const limit = pLimit(SCAN_CONCURRENCY)
  const read = await Promise.all(candidates.map((c) => limit(() => readCandidate(c, coreGames))))
  const worlds = read.filter((w): w is WorldInfo => w !== null)
  if (paths.coreWorlds === '') {
    const custom = worlds.filter((w) => w.location === 'custom')
    const others = worlds.filter((w) => w.location !== 'custom')
    return computeStates([...custom, ...tableWorlds(apVersion), ...others], apVersion)
  }
  return computeStates(worlds, apVersion)
}

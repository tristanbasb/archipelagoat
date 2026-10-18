// What the app reads of a `.archipelago` (spec §3.3): how many checks each slot has, with the name and
// game of its player, and how many locations each game has. The file is the format byte 3, then the zlib
// of a pickle (MultiServer.py:514-536) of a dict; only the keys below are read, through the data-only
// pickle reader. Nothing in it is run.
import { inflateSync } from 'node:zlib'
import { AppError } from '@shared/errors'
import { listZip, readZipBytes, type ZipLimits } from '../system/archive'
import type { GameLocations } from './datapackage'
import { isPickleObject, isPickleTuple, unpickle, unreadable, type PickleValue } from './pickle'

/** The format byte of Archipelago 0.6.8; another version of AP may write another. */
const FORMAT_VERSION = 3

/** What a multidata may inflate to; a real one with dozens of players is a few MB. */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024

/** A generation's own archive: bigger than an archive from the outside may be (as in `ap/generate`). */
const ZIP_LIMITS: Partial<ZipLimits> = { maxUncompressed: 2 * 1024 * 1024 * 1024 }

export interface MultidataLimits {
  /** The most bytes the file may inflate to (and the most the file may have inside a zip). Default: 256 MiB. */
  maxInflatedBytes?: number
}

export interface MultidataSummary {
  /** The format byte of the file (3 for Archipelago 0.6.8), not the version of Archipelago. */
  version: number
  /** One entry per slot that has locations, by slot number. `name` and `game` are '' when no table gives them. */
  slots: { slot: number; name: string; game: string; checks: number }[]
  /** How many locations each game has (the keys of its `location_name_to_id`), and its datapackage checksum. */
  datapackage: Record<string, GameLocations>
}

const shape = (detail: string) => unreadable('shape', detail)

function inflate(compressed: Uint8Array, maxOutputLength: number): Buffer {
  try {
    return inflateSync(compressed, { maxOutputLength })
  } catch (error) {
    // zlib refuses to grow a buffer past maxOutputLength with a RangeError of this code.
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw unreadable('size', `more than ${maxOutputLength} bytes once inflated`)
    }
    throw unreadable('truncated', `zlib: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `{ name, game }` of a `NetUtils.NetworkSlot` (its arguments are `(name, game, type, group_members)`). */
function networkSlot(value: PickleValue | undefined): { name: string; game: string } | null {
  if (!isPickleObject(value) || !isPickleTuple(value.object.args)) return null
  const [name, game] = value.object.args.tuple
  return typeof name === 'string' && typeof game === 'string' ? { name, game } : null
}

/** `connect_names` is `{name: (team, slot)}`; the first name of a slot wins. */
function namesBySlot(connectNames: PickleValue | undefined): Map<number, string> {
  const names = new Map<number, string>()
  if (!(connectNames instanceof Map)) return names
  for (const [name, where] of connectNames) {
    const slot = isPickleTuple(where) ? where.tuple[1] : undefined
    if (typeof name === 'string' && typeof slot === 'number' && !names.has(slot)) names.set(slot, name)
  }
  return names
}

function summarizeSlots(root: Map<PickleValue, PickleValue>): MultidataSummary['slots'] {
  const locations = root.get('locations')
  if (!(locations instanceof Map)) throw shape('no locations')
  const info = root.get('slot_info')
  const connectNames = namesBySlot(root.get('connect_names'))
  const slots: MultidataSummary['slots'] = []
  for (const [slot, checks] of locations) {
    if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 1) {
      throw shape('a slot number that is not a positive integer')
    }
    if (!(checks instanceof Map)) throw shape(`the locations of slot ${slot} are not a dict`)
    const given = networkSlot(info instanceof Map ? info.get(slot) : undefined)
    slots.push({
      slot,
      name: given?.name ?? connectNames.get(slot) ?? '',
      game: given?.game ?? '',
      checks: checks.size,
    })
  }
  return slots.sort((a, b) => a.slot - b.slot)
}

function summarizeDatapackage(datapackage: PickleValue | undefined): Record<string, GameLocations> {
  if (datapackage === undefined) return {}
  if (!(datapackage instanceof Map)) throw shape('the datapackage is not a dict')
  const games: [string, GameLocations][] = []
  for (const [game, table] of datapackage) {
    if (typeof game !== 'string' || !(table instanceof Map)) continue
    const names = table.get('location_name_to_id')
    // A game with no table of locations has nothing to estimate from.
    if (!(names instanceof Map)) continue
    const checksum = table.get('checksum')
    games.push([game, { max: names.size, checksum: typeof checksum === 'string' ? checksum : null }])
  }
  // Built by entries, not by assignment: no game name can reach the prototype.
  return Object.fromEntries(games)
}

/**
 * The summary of a multidata file. Throws MULTIDATA_UNREADABLE with `reason`: `version` (another format
 * byte), `size` (inflates past `limits.maxInflatedBytes`), `truncated` (zlib or pickle ends early or is
 * damaged), `opcode` and `depth` (from the pickle reader), `shape` (a pickle that is no multidata: no
 * `locations`, or a slot that is not a number of checks).
 */
export function readMultidata(bytes: Uint8Array, limits: MultidataLimits = {}): MultidataSummary {
  const version = bytes[0]
  if (version === undefined) throw unreadable('truncated', 'the file is empty')
  if (version !== FORMAT_VERSION) {
    throw unreadable('version', `format ${version}, only ${FORMAT_VERSION} is read`)
  }
  const root = unpickle(inflate(bytes.subarray(1), limits.maxInflatedBytes ?? MAX_INFLATED_BYTES))
  if (!(root instanceof Map)) throw shape('the pickle is not a dict')
  return { version, slots: summarizeSlots(root), datapackage: summarizeDatapackage(root.get('datapackage')) }
}

/** The bytes of the one `.archipelago` at the top of a generation's zip. */
async function readEntry(zipPath: string, maxBytes: number): Promise<Buffer> {
  try {
    const found = (await listZip(zipPath, ZIP_LIMITS)).filter(
      (entry) => !entry.isDir && !entry.name.includes('/') && entry.name.endsWith('.archipelago'),
    )
    const [entry, ...others] = found
    if (entry === undefined) throw new AppError('AP_NO_ARCHIPELAGO_IN_ZIP', undefined, { detail: zipPath })
    if (others.length > 0) throw shape(`${found.length} .archipelago files in ${zipPath}`)
    // An entry over `maxBytes` is refused here, before it is read (WORLD_INVALID `zip-bomb`, mapped below).
    const bytes = await readZipBytes(zipPath, entry.name, maxBytes)
    if (bytes === null) throw unreadable('truncated', `${entry.name} cannot be read from ${zipPath}`)
    return bytes
  } catch (error) {
    // The archive helpers call any unacceptable zip WORLD_INVALID: here it is an unreadable multidata.
    if (error instanceof AppError && error.code === 'WORLD_INVALID') {
      throw unreadable(error.params?.reason === 'zip-bomb' ? 'size' : 'truncated', error.detail ?? zipPath)
    }
    throw error
  }
}

/**
 * `readMultidata` of the `.archipelago` in `zipPath`, the `AP_<seed>.zip` of a generation. Throws
 * AP_NO_ARCHIPELAGO_IN_ZIP when the zip has none, NOT_FOUND when the file does not exist, and
 * MULTIDATA_UNREADABLE for the rest (`shape` for several of them; `truncated` for a file that is no zip).
 */
export async function readMultidataFromZip(
  zipPath: string,
  limits: MultidataLimits = {},
): Promise<MultidataSummary> {
  return readMultidata(await readEntry(zipPath, limits.maxInflatedBytes ?? MAX_INFLATED_BYTES), limits)
}

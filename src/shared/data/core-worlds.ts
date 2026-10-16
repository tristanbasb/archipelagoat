// The worlds that ship with Archipelago, per AP version. Used when the Archipelago folder cannot be
// read (an AppImage that is not mounted) and as a guard in the tests.
//
// The table is generated from the Archipelago source tree by scripts/gen-core-worlds.mjs; never edit
// the JSON by hand.
import core068 from '../../../resources/core-worlds-0.6.8.json'

export interface CoreWorld {
  /** Folder (and module name) under worlds/. */
  module: string
  /** The `game` of its World class. */
  game: string
  /**
   * True for a world the frozen build ships as a plain folder instead of an .apworld. A loose world
   * can never be overridden by a custom world (research brief 1.10).
   */
  loose: boolean
}

/** The table used for a version, and whether it is that version's own table. */
export interface CoreWorldsTable {
  /** Version of the table, e.g. `0.6.8`. */
  apVersion: string
  worlds: CoreWorld[]
  /** False when the version has no table of its own and the nearest lower one stands in for it. */
  exact: boolean
}

const TABLES = new Map<string, readonly CoreWorld[]>([[core068.apVersion, core068.worlds]])

/** `0.6.8` or `0.6.8-rc1` → [0, 6, 8]; anything else → null. */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * The core worlds table for an Archipelago version (a leading `v` is accepted). The app targets 0.6.8
 * and tolerates any 0.6.x: a version without a table of its own gets the nearest lower table of the
 * same major.minor (0.6.9 → 0.6.8), flagged `exact: false`. Null when there is none.
 */
export function coreWorldsTableFor(apVersion: string): CoreWorldsTable | null {
  const normalized = apVersion.trim().replace(/^v/i, '')
  const wanted = parseVersion(normalized)
  if (!wanted) return null
  let best: { version: string; worlds: readonly CoreWorld[]; patch: number } | null = null
  for (const [version, worlds] of TABLES) {
    const parsed = parseVersion(version)
    if (!parsed || parsed[0] !== wanted[0] || parsed[1] !== wanted[1] || parsed[2] > wanted[2]) continue
    if (!best || parsed[2] > best.patch) best = { version, worlds, patch: parsed[2] }
  }
  if (!best) return null
  return {
    apVersion: best.version,
    worlds: best.worlds.map((world) => ({ ...world })),
    exact: best.version === normalized,
  }
}

/** The core worlds of an Archipelago version, with the same 0.6.x tolerance; null if unknown. */
export function coreWorldsFor(apVersion: string): CoreWorld[] | null {
  return coreWorldsTableFor(apVersion)?.worlds ?? null
}

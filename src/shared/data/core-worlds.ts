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

const TABLES = new Map<string, readonly CoreWorld[]>([[core068.apVersion, core068.worlds]])

/** The core worlds of one Archipelago version (`0.6.8`, a leading `v` is accepted), or null if unknown. */
export function coreWorldsFor(apVersion: string): CoreWorld[] | null {
  const table = TABLES.get(apVersion.trim().replace(/^v/i, ''))
  return table === undefined ? null : table.map((world) => ({ ...world }))
}

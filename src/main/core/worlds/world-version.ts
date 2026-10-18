// The version of the world Archipelago loads for a game, as measured counts and refined profiles are
// kept for it (spec §3.4, §3.6).
import { stat } from 'node:fs/promises'
import type { ValidationContext } from '../yaml/validate'

/**
 * The version of the world Archipelago loads for `game` that its counts hold for: its world_version;
 * Archipelago's own (`apVersion`) for a core world; for a custom world without one, the size and the
 * modification time of its file, so that updating it (the catalog always offers it, its version being
 * unknown) makes its counts stale. Null when Archipelago does not load the game, or its file is gone.
 */
export async function loadedWorldVersion(
  installed: ValidationContext['installedGames'],
  game: string,
  apVersion: string | null,
): Promise<string | null> {
  const world = installed.get(game)
  if (world === undefined) return null
  if (world.worldVersion !== null) return world.worldVersion
  if (world.file === undefined) return apVersion
  const info = await stat(world.file).catch(() => null)
  return info === null ? null : `file:${info.size}:${info.mtimeMs}`
}

// The files the user picked in this run, in a dialog of the main process or by opening them: the only
// paths a file the renderer names may be written at (spec §6.1). Whatever else the renderer names, a
// bug or worse, it cannot overwrite Archipelago's host.yaml or any other file of the user.
import path from 'node:path'
import type { OS } from '@shared/types'

export interface PickedPaths {
  add(p: string): void
  /** True when the user picked `p` in this run (on Windows, whatever its case). */
  has(p: string): boolean
}

export function createPickedPaths(os: OS): PickedPaths {
  const lib = os === 'win32' ? path.win32 : path.posix
  const keyOf = (p: string): string => {
    const normalized = lib.normalize(p)
    return os === 'win32' ? normalized.toLowerCase() : normalized
  }
  const picked = new Set<string>()
  return {
    add: (p) => void picked.add(keyOf(p)),
    has: (p) => picked.has(keyOf(p)),
  }
}

// Rules about catalog entries shared by the main process and the renderer, so that both decide the
// same way what the catalog can install and whether it has a later version.
import { isAllowedExternalUrl } from './external-url'
import type { CatalogEntry } from './types'

/**
 * The catalog has something to download for the entry: a release of the index, or the latest
 * GitHub release a wiki page points to (resolved when it is installed). Never a world the index
 * disables.
 */
export const isInstallable = (entry: CatalogEntry): boolean =>
  !entry.disabledByIndex && (entry.latest !== null || entry.download?.kind === 'github-latest')

function numericParts(version: string): number[] {
  return (version.match(/\d+/g) ?? []).map(Number)
}

/** True when `candidate` is a later version than `current`, comparing their numbers in turn. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = numericParts(candidate)
  const now = numericParts(current)
  if (next.length === 0 || now.length === 0) return candidate !== current
  for (let index = 0; index < Math.max(next.length, now.length); index += 1) {
    const diff = (next[index] ?? 0) - (now[index] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/**
 * The page the player downloads a world from by hand, for a wiki world the catalog cannot install:
 * its download page, else (a site the app does not open) its wiki page, which links to it. Null
 * for any other entry, and for a world the index disables (nothing offers it to install).
 */
export function downloadPageOf(entry: CatalogEntry): string | null {
  if (entry.disabledByIndex || isInstallable(entry) || entry.download?.kind !== 'page') return null
  return isAllowedExternalUrl(entry.download.url) ? entry.download.url : (entry.wiki?.url ?? null)
}

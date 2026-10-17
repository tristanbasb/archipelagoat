// Rules about catalog entries shared by the main process and the renderer, so that both decide the
// same way what the catalog can install.
import { isAllowedExternalUrl } from './external-url'
import type { CatalogEntry } from './types'

/**
 * The catalog has something to download for the entry: a release of the index, or the latest
 * GitHub release a wiki page points to (resolved when it is installed).
 */
export const isInstallable = (entry: CatalogEntry): boolean =>
  entry.latest !== null || entry.download?.kind === 'github-latest'

/**
 * The page the player downloads a world from by hand, for a wiki world the catalog cannot install:
 * its download page, else (a site the app does not open) its wiki page, which links to it. Null
 * for any other entry.
 */
export function downloadPageOf(entry: CatalogEntry): string | null {
  if (isInstallable(entry) || entry.download?.kind !== 'page') return null
  return isAllowedExternalUrl(entry.download.url) ? entry.download.url : (entry.wiki?.url ?? null)
}

import { downloadPageOf, isInstallable } from '@shared/catalog'
import type { CatalogEntry } from '@shared/types'

function entryOf(fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'celeste',
    source: 'index',
    game: 'Celeste',
    displayName: 'Celeste',
    homepage: null,
    tags: [],
    supported: false,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    cover: null,
    wiki: null,
    latest: null,
    download: null,
    installedVersion: null,
    trust: 'unknown',
    disabledByIndex: false,
    ...fields,
  }
}

const RELEASE = {
  version: '1.0.0',
  url: 'https://github.com/doshyw/CelesteArchipelago/releases/download/1.0.0/celeste.apworld',
  sha256: null,
}
const PAGE = { kind: 'page', url: 'https://github.com/doshyw/CelesteArchipelago/releases/latest' } as const
const LATEST = {
  kind: 'github-latest',
  repo: 'doshyw/celestearchipelago',
  pageUrl: 'https://github.com/doshyw/CelesteArchipelago/releases/latest',
} as const

describe('isInstallable', () => {
  it('is true for a release of the index, or the latest GitHub release of a wiki page', () => {
    expect(isInstallable(entryOf({ latest: RELEASE }))).toBe(true)
    expect(isInstallable(entryOf({ source: 'wiki', download: LATEST }))).toBe(true)
    expect(isInstallable(entryOf({ source: 'wiki', download: PAGE }))).toBe(false)
    expect(isInstallable(entryOf())).toBe(false)
  })

  it('is never true for a world the index disables, whatever it carries', () => {
    expect(isInstallable(entryOf({ disabledByIndex: true, latest: RELEASE }))).toBe(false)
    expect(isInstallable(entryOf({ disabledByIndex: true, download: LATEST }))).toBe(false)
  })
})

describe('downloadPageOf', () => {
  it('gives the page of a world the catalog cannot install, never one the index disables', () => {
    expect(downloadPageOf(entryOf({ source: 'wiki', download: PAGE }))).toBe(PAGE.url)
    expect(downloadPageOf(entryOf({ disabledByIndex: true, download: PAGE }))).toBeNull()
  })
})

// Pure helpers of the worlds screen: names, search, versions, states and sizes.
import { isInstallable, isNewerVersion } from '@shared/catalog'
import type { CatalogEntry, WorldInfo, WorldState } from '@shared/types'
import type { Tone } from '../../design/classes'

/** The name a world goes by: its game, else the module of its folder. */
export function worldName(world: WorldInfo): string {
  return world.game ?? world.manifest?.game ?? world.module
}

/** Lowercase and without accents, so that "pokémon" finds "Pokemon". */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * True when every word of the query appears in one of the fields, or is one of the `keywords`
 * (matched as whole words only).
 */
export function matchesQuery(
  query: string,
  fields: readonly (string | null | undefined)[],
  keywords: readonly string[] = [],
): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = normalize(fields.filter(Boolean).join('\n'))
  const whole = new Set(keywords.map(normalize))
  return words.every((word) => whole.has(word) || haystack.includes(word))
}

/** The folder that holds a world (a world file itself cannot be opened). */
export function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : path
}

/** Worst first: the order of the badges and of the state filter. */
export const STATE_ORDER: readonly WorldState[] = [
  'corrupt',
  'bad-name',
  'incompatible',
  'no-manifest',
  'shadowed',
  'disabled',
  'core-loose',
  'ok',
]

/** States the user can act on (badges reachable from the keyboard). */
export const ACTIONABLE_STATES: ReadonlySet<WorldState> = new Set([
  'corrupt',
  'bad-name',
  'incompatible',
  'no-manifest',
  'shadowed',
  'disabled',
])

/** The badges of a world, worst first; `ok` only when there is nothing else to say. */
export function badgeStates(world: WorldInfo): WorldState[] {
  const states = STATE_ORDER.filter((state) => state !== 'ok' && world.states.includes(state))
  return states.length > 0 ? states : ['ok']
}

export function countStates(worlds: readonly WorldInfo[]): Record<WorldState, number> {
  const counts = Object.fromEntries(STATE_ORDER.map((state) => [state, 0])) as Record<WorldState, number>
  for (const world of worlds) for (const state of new Set(world.states)) counts[state] += 1
  return counts
}

/**
 * « Jeu prêt » can start from the entry: a core world or one already installed (nothing to download),
 * or one the catalog can download. A world downloaded by hand from its page keeps that page instead.
 */
export function offersReady(entry: CatalogEntry): boolean {
  return entry.trust === 'core' || entry.installedVersion !== null || isInstallable(entry)
}

/** States in which Archipelago does not load a world (or loads another copy of its game). */
const UNLOADED_STATES: ReadonlySet<WorldState> = new Set([
  'disabled',
  'corrupt',
  'incompatible',
  'bad-name',
  'shadowed',
])

/** Archipelago loads this copy of the world: a game can be played from it. */
export const isLoadedWorld = (world: WorldInfo): boolean =>
  !world.states.some((state) => UNLOADED_STATES.has(state))

/** Letters and digits only, lowercase, without accents: "Pokémon: Crystal" finds "Pokemon Crystal". */
const compact = (text: string): string => normalize(text).replace(/[^\p{L}\p{N}]/gu, '')

/**
 * The catalog entry « Jeu prêt » starts from for an installed world Archipelago loads: the one of its
 * game, else of the same name told apart by punctuation or accents alone, else (no game known) the
 * one its module is the id of. Null for a world not loaded or that the catalog does not list.
 */
export function readyEntryOf(world: WorldInfo, entries: readonly CatalogEntry[]): CatalogEntry | null {
  if (!isLoadedWorld(world)) return null
  const game = world.game ?? world.manifest?.game ?? null
  const byGame =
    game === null
      ? undefined
      : (entries.find((entry) => entry.game === game) ??
        entries.find((entry) => compact(entry.game) === compact(game)))
  const found = byGame ?? entries.find((entry) => entry.id === world.module)
  return found !== undefined && offersReady(found) ? found : null
}

/** An installed world for which the catalog has a later version. */
export function hasUpdate(entry: CatalogEntry): boolean {
  return (
    entry.installedVersion !== null &&
    entry.latest !== null &&
    isNewerVersion(entry.latest.version, entry.installedVersion)
  )
}

/** The catalog as the user may see it: "After Dark" worlds only when the settings allow them. */
export function visibleEntries(entries: readonly CatalogEntry[], showAfterDark: boolean): CatalogEntry[] {
  return showAfterDark ? [...entries] : entries.filter((entry) => !entry.afterDark)
}

/** The color of a wiki status (free text on the wiki: Stable, Unstable, Broken on Main…). */
export function statusTone(status: string): Tone {
  if (/broken/i.test(status)) return 'pink'
  if (/unstable|beta|alpha|wip|experimental|in development/i.test(status)) return 'yellow'
  if (/stable|complete|verified/i.test(status)) return 'green'
  return 'neutral'
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

/** "1,2 Mo" / "1.2 MB". */
export function formatBytes(bytes: number, lang: string): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return new Intl.NumberFormat(lang, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0,
  }).format(value)
}

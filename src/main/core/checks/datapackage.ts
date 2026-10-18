// How many checks a game can have, known before anything is generated (spec §3.2): the number of
// locations of each game in the datapackage of archipelago.gg, refreshed once a week, plus the
// games the app generated itself (custom worlds are not on archipelago.gg). Only `{ max, checksum }`
// per game is kept: the table is a few KB on disk, `dataRoot/checks/datapackage.json`.
import path from 'node:path'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { writeFileAtomic } from '../system/fsx'
import { compactKey } from '../worlds/catalog'

export const DATAPACKAGE_URL = 'https://archipelago.gg/api/datapackage'

const MAX_BYTES = 32 * 1024 * 1024
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000
/** One deadline for the answer and its 11 MB body. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** What the table keeps of a game: how many locations it has, and the checksum of its datapackage. */
export interface GameLocations {
  max: number
  checksum: string | null
}

/** Only what is read of the answer: the rest (item maps, groups) is dropped by the schema. */
const datapackageSchema = z.object({
  games: z.record(
    z.string(),
    z.object({
      checksum: z.string().nullish(),
      location_name_to_id: z.record(z.string(), z.number()),
    }),
  ),
})

/**
 * `{ max, checksum }` of each game of an answer of `/api/datapackage`; `max` is the number of keys of
 * `location_name_to_id`. A game with no location is left out: it has nothing to estimate. Throws
 * HTTP_ERROR when the answer is not a datapackage (a proxy page, a changed API).
 */
export function parseDatapackage(json: unknown): Record<string, GameLocations> {
  const parsed = datapackageSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.map(String).join('.') ?? ''
    throw new AppError(
      'HTTP_ERROR',
      { status: 200, url: DATAPACKAGE_URL },
      { detail: `not a datapackage: ${where === '' ? '<answer>' : where}: ${issue?.message ?? 'invalid'}` },
    )
  }
  const games = Object.entries(parsed.data.games)
    .map(([game, { checksum, location_name_to_id }]): [string, GameLocations] => [
      game,
      { max: Object.keys(location_name_to_id).length, checksum: checksum ?? null },
    ])
    .filter(([, { max }]) => max > 0)
  // Built by entries, not by assignment: no game name can reach the prototype.
  return Object.fromEntries(games)
}

/** `dataRoot/checks/datapackage.json`. A file that does not have this shape is as good as none. */
const storedSchema = z.object({
  fetchedAt: z.number().nullable(),
  etag: z.string().nullable(),
  games: z.record(
    z.string(),
    z.object({ max: z.number().int().positive(), checksum: z.string().nullable() }),
  ),
})

export interface CheckEstimates {
  /**
   * The most checks `game` can have (its number of locations); null when no table knows the game.
   * Read from memory: a name that differs only in accents, case or punctuation is the same game.
   */
  maxFor(game: string): number | null
  /**
   * Downloads the datapackage unless the last answer is under a week old (`force` asks anyway), with
   * the ETag of the last one. Never rejects: a refresh that fails is logged and the table stays as it
   * was. Asked while another runs, it waits for that one.
   */
  refresh(force?: boolean): Promise<void>
  /**
   * Adds the games of the datapackage of a multidata (a measure or a real generation): that is how a
   * custom world gets an estimate. A game already known with the same checksum keeps the larger of the
   * two; with another checksum (another version of the game, or none known) the new entry replaces it.
   */
  addFromMultidata(dp: Record<string, GameLocations>): Promise<void>
}

export interface CheckEstimatesDeps {
  /** The clock of the weekly rule. Default: `Date.now`. */
  now?: () => number
}

export function createCheckEstimates(ctx: CoreContext, deps: CheckEstimatesDeps = {}): CheckEstimates {
  const file = path.join(ctx.platform.paths.dataRoot, 'checks', 'datapackage.json')
  const now = deps.now ?? Date.now

  // --- the table, in memory and on disk ---

  const games = new Map<string, GameLocations>()
  let fetchedAt: number | null = null
  let etag: string | null = null
  const stored = storedSchema.safeParse(readJsonSync(file))
  if (stored.success) {
    fetchedAt = stored.data.fetchedAt
    etag = stored.data.etag
    for (const [game, entry] of Object.entries(stored.data.games)) games.set(game, entry)
  }

  /** The largest `max` by `compactKey`, built when a name is not found as it is written. */
  let byCompactKey: Map<string, number> | null = null
  function compactIndex(): Map<string, number> {
    if (byCompactKey === null) {
      byCompactKey = new Map()
      for (const [game, { max }] of games) {
        const key = compactKey(game)
        byCompactKey.set(key, Math.max(byCompactKey.get(key) ?? 0, max))
      }
    }
    return byCompactKey
  }

  let writing: Promise<void> = Promise.resolve()
  /** Writes the table as it is now; the writes run one after the other. Never rejects. */
  function save(): Promise<void> {
    const content = JSON.stringify({ fetchedAt, etag, games: Object.fromEntries(games) })
    writing = writing
      .then(() => writeFileAtomic(file, content))
      .catch((error: unknown) => ctx.log.warn('checks: cannot save the datapackage table', error))
    return writing
  }

  /** True when the table changed. */
  function merge(game: string, incoming: GameLocations): boolean {
    const known = games.get(game)
    const sameVersion = known !== undefined && known.checksum !== null && known.checksum === incoming.checksum
    const next = sameVersion ? { ...known, max: Math.max(known.max, incoming.max) } : incoming
    if (known?.max === next.max && known.checksum === next.checksum) return false
    games.set(game, next)
    byCompactKey = null
    return true
  }

  // --- the download ---

  /** The body of an answer, read up to the size limit and not a byte further. */
  async function readBody(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'))
    if (declared > MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`${declared} bytes declared`)
    }
    const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined
    if (!reader) throw new Error('no body')
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, total).toString('utf8')
      total += value.length
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('over the size limit')
      }
      chunks.push(value)
    }
  }

  async function download(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const res = await ctx.http.fetchRaw(DATAPACKAGE_URL, {
        headers: { accept: 'application/json', ...(etag === null ? {} : { 'if-none-match': etag }) },
        signal: controller.signal,
      })
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined)
        fetchedAt = now()
        await save()
        return
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new AppError('HTTP_ERROR', { status: res.status, url: DATAPACKAGE_URL })
      }
      const answer = parseDatapackage(JSON.parse(await readBody(res)))
      let changed = false
      for (const [game, entry] of Object.entries(answer)) changed = merge(game, entry) || changed
      fetchedAt = now()
      etag = res.headers.get('etag')
      await save()
      if (changed) ctx.bus.emit('checks:changed', null)
    } finally {
      clearTimeout(timer)
    }
  }

  let running: Promise<void> | null = null

  return {
    maxFor(game) {
      const key = compactKey(game)
      return games.get(game)?.max ?? (key === '' ? undefined : compactIndex().get(key)) ?? null
    },

    refresh(force = false) {
      if (running) return running
      // A clock set back counts as an old answer: the week is measured forwards only.
      const age = fetchedAt === null ? Infinity : now() - fetchedAt
      if (!force && age >= 0 && age < REFRESH_EVERY_MS) return Promise.resolve()
      running = download()
        .catch((error: unknown) => ctx.log.warn('checks: cannot refresh the datapackage', error))
        .finally(() => {
          running = null
        })
      return running
    },

    async addFromMultidata(dp) {
      let changed = false
      for (const [game, entry] of Object.entries(dp)) {
        if (Number.isInteger(entry.max) && entry.max > 0) changed = merge(game, entry) || changed
      }
      if (!changed) return
      await save()
      ctx.bus.emit('checks:changed', null)
    },
  }
}

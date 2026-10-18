// Game covers (spec §3.1): the boxart the wiki shows for a game, downloaded once into
// `dataRoot/covers/` after checks (host, size, image signature) and shown through `goat-cover://`, so
// the renderer never loads a remote image. `index.json` lists what the folder holds; a file name is
// the sha256 of the remote link plus the extension of the type found in the bytes.
import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import pLimit from 'p-limit'
import { z } from 'zod'
import { COVER_SCHEME, isCoverUrl } from '@shared/covers'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { pathExists, writeFileAtomic } from '../system/fsx'
import { readCapped, startDeadline } from '../system/http'
import { compactKey, type Catalog } from '../worlds/catalog'

export type ImageType = 'png' | 'jpeg' | 'webp' | 'gif'

const MIME: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000
const MAX_DOWNLOADS = 4
const MAX_REDIRECTS = 3
const DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024
/** A view is saved when the saved one is older than this: showing a grid is not a write per card. */
const SAVED_VIEW_MS = 60 * 60 * 1000

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const GIF87 = ascii('GIF87a')
const GIF89 = ascii('GIF89a')
const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')

const hasBytes = (bytes: Uint8Array, expected: readonly number[], at = 0): boolean =>
  expected.every((byte, offset) => bytes[at + offset] === byte)

/** The type of an image by its first bytes (a `Content-Type` proves nothing); null for anything else. */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  if (hasBytes(bytes, PNG)) return 'png'
  if (hasBytes(bytes, JPEG)) return 'jpeg'
  if (hasBytes(bytes, GIF87) || hasBytes(bytes, GIF89)) return 'gif'
  if (hasBytes(bytes, RIFF) && hasBytes(bytes, WEBP, 8)) return 'webp'
  return null
}

/** What `serve` accepts as a name: the shape of the files this module writes, nothing else. */
const FILE_NAME = /^[0-9a-f]{64}\.(png|jpeg|webp|gif)$/

const indexSchema = z.record(
  z.string(),
  z.object({
    url: z.string(),
    bytes: z.number().int().nonnegative(),
    lastViewed: z.number(),
    /** The games (see `compactKey`) showing this file: a game whose link changes drops its old file. */
    games: z.array(z.string()).default([]),
  }),
)
type Entry = z.infer<typeof indexSchema>[string]

export interface Covers {
  /**
   * The `goat-cover://` link of the cover of a game, downloaded on the first ask; null for a game
   * with no cover, one that is After Dark without `showAfterDark`, or when the download fails (the
   * reason is logged). Offline, what is cached is still answered.
   */
  urlFor(game: string): Promise<string | null>
  /** The cached file named `key` and its type; null for anything but a name this module wrote. */
  serve(key: string): Promise<{ bytes: Buffer; mime: string } | null>
}

export interface CoversDeps {
  lookupCover: Catalog['lookupCover']
  /** The clock of the views. Default: `Date.now`. */
  now?: () => number
  /** Default: 100 MB. */
  maxCacheBytes?: number
}

export function createCovers(ctx: CoreContext, deps: CoversDeps): Covers {
  const dir = path.join(ctx.platform.paths.dataRoot, 'covers')
  const indexFile = path.join(dir, 'index.json')
  const now = deps.now ?? Date.now
  const maxCacheBytes = deps.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES
  const queue = pLimit(MAX_DOWNLOADS)
  const inFlight = new Map<string, Promise<string | null>>()

  // A name that is not one of ours is dropped, whoever wrote the index.
  const saved = indexSchema.safeParse(readJsonSync(indexFile))
  const index = new Map<string, Entry>(
    saved.success ? Object.entries(saved.data).filter(([key]) => FILE_NAME.test(key)) : [],
  )

  // --- the folder and its index on disk ---

  /**
   * Deletes what the folder holds besides the index and the files it lists: the cache limit counts
   * what the index lists, so a file left by a crash between its write and the save of the index,
   * by an index that could not be read, or a temporary file of an interrupted write would stay
   * forever. Nothing outside covers/ is looked at.
   */
  async function sweep(): Promise<void> {
    try {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const listed = FILE_NAME.test(item.name) && index.has(item.name)
        if (!item.isFile() || item.name === 'index.json' || listed) continue
        await rm(path.join(dir, item.name), { force: true })
      }
    } catch (error) {
      // No folder yet: nothing to sweep.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        ctx.log.warn('covers: cannot sweep covers/', error)
    }
  }
  let swept: Promise<void> | null = null
  /** The sweep, once, before the first answer: it must end before a download writes a file. */
  const ready = (): Promise<void> => (swept ??= sweep())

  let writing: Promise<void> = Promise.resolve()
  let queued = false
  /** Writes the index; asks made while a write is waiting its turn share it. Never rejects. */
  function save(): Promise<void> {
    if (!queued) {
      queued = true
      writing = writing
        .then(() => {
          queued = false
          return writeFileAtomic(indexFile, JSON.stringify(Object.fromEntries(index)))
        })
        .catch((error: unknown) => ctx.log.warn('covers: cannot save the index', error))
    }
    return writing
  }

  async function remove(key: string): Promise<void> {
    index.delete(key)
    await rm(path.join(dir, key), { force: true }).catch((error: unknown) =>
      ctx.log.warn(`covers: cannot remove ${key}`, error),
    )
  }

  /** Removes the least recently viewed files until the cache fits; `keep` is never one of them. */
  async function evict(keep: string): Promise<void> {
    let total = 0
    for (const entry of index.values()) total += entry.bytes
    const oldestFirst = [...index]
      .filter(([key]) => key !== keep)
      .sort(([, a], [, b]) => a.lastViewed - b.lastViewed)
    for (const [key, entry] of oldestFirst) {
      if (total <= maxCacheBytes) break
      total -= entry.bytes
      await remove(key)
    }
  }

  /** `game` shows the file `key` from now on: the one it showed before goes unless another game shows it. */
  async function assign(game: string, key: string): Promise<void> {
    const entry = index.get(key)
    if (!entry || entry.games.includes(game)) return
    entry.games.push(game)
    for (const [other, previous] of [...index]) {
      if (other === key || !previous.games.includes(game)) continue
      previous.games = previous.games.filter((name) => name !== game)
      if (previous.games.length === 0) await remove(other)
    }
    await save()
  }

  // --- the download ---

  /**
   * GET with one deadline for the answer and its body. Redirects are followed here, a few times, and
   * only to a cover host: the platform would follow them anywhere.
   */
  async function fetchImage(url: string): Promise<Buffer> {
    const deadline = startDeadline(DOWNLOAD_TIMEOUT_MS)
    try {
      let target = url
      for (let redirects = 0; ; redirects++) {
        const res = await ctx.http.fetchRaw(target, {
          headers: { accept: 'image/*' },
          redirect: 'manual',
          signal: deadline.signal,
        })
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined)
          const location = res.headers.get('location')
          const next = location === null ? '' : new URL(location, target).href
          if (redirects === MAX_REDIRECTS || !isCoverUrl(next)) throw new Error(`redirected to ${location}`)
          target = next
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          throw new Error(`HTTP ${res.status}`)
        }
        return await readCapped(res, MAX_IMAGE_BYTES)
      }
    } finally {
      deadline.release()
    }
  }

  /** The key of the cover downloaded from `url`; null (logged) when it cannot be had. */
  async function download(url: string): Promise<string | null> {
    try {
      const bytes = await fetchImage(url)
      const type = imageTypeOf(bytes)
      if (type === null) throw new Error('not an image')
      const key = `${createHash('sha256').update(url).digest('hex')}.${type}`
      await writeFileAtomic(path.join(dir, key), bytes)
      index.set(key, { url, bytes: bytes.length, lastViewed: now(), games: [] })
      await evict(key)
      await save()
      return key
    } catch (error) {
      ctx.log.warn(`covers: cannot download ${url}`, error)
      return null
    }
  }

  /** The key of the cached file of `url`, counted as viewed; null when there is none. */
  async function cached(url: string): Promise<string | null> {
    for (const [key, entry] of index) {
      if (entry.url !== url) continue
      if (!(await pathExists(path.join(dir, key)))) {
        // Removed from outside: downloaded again.
        index.delete(key)
        return null
      }
      const viewed = now()
      const stale = viewed - entry.lastViewed >= SAVED_VIEW_MS
      entry.lastViewed = viewed
      if (stale) void save()
      return key
    }
    return null
  }

  return {
    async urlFor(game) {
      await ready()
      const cover = deps.lookupCover(game)
      if (cover === null || !isCoverUrl(cover.url)) return null
      if (cover.afterDark && !ctx.config.get().showAfterDark) return null
      let pending = inFlight.get(cover.url)
      if (!pending) {
        const { url } = cover
        pending = cached(url)
          .then((key) => key ?? queue(() => download(url)))
          .finally(() => inFlight.delete(url))
        inFlight.set(url, pending)
      }
      const key = await pending
      if (key === null) return null
      await assign(compactKey(game), key)
      return `${COVER_SCHEME}://${key}`
    },

    async serve(key) {
      await ready()
      const type = FILE_NAME.exec(key)?.[1] as ImageType | undefined
      if (type === undefined || !index.has(key)) return null
      try {
        return { bytes: await readFile(path.join(dir, key)), mime: MIME[type] }
      } catch {
        // Removed from outside.
        index.delete(key)
        void save()
        return null
      }
    },
  }
}

/** The file name asked by a `goat-cover://<name>` link; null for any other link or one with more in it. */
export function coverKeyOf(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const plain =
    url.protocol === `${COVER_SCHEME}:` &&
    (url.pathname === '' || url.pathname === '/') &&
    url.search === '' &&
    url.hash === '' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  return plain && url.hostname !== '' ? url.hostname : null
}

/** The answer of the `goat-cover` protocol: the cached file, or 404 for anything else. */
export async function handleCoverRequest(covers: Pick<Covers, 'serve'>, link: string): Promise<Response> {
  const key = coverKeyOf(link)
  const cover = key === null ? null : await covers.serve(key)
  if (cover === null) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(cover.bytes), {
    headers: { 'content-type': cover.mime, 'x-content-type-options': 'nosniff' },
  })
}

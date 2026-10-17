// The archipelago.gg client (spec §3.14, research brief §1.8). Every request goes through
// `Http.fetchRaw` (the app's user agent) with the cookie jar, `redirect: 'manual'` (the 302s of
// /uploads and /new_room carry the ids, and following the one of POST /room would wake the room), and a
// deadline that covers the body too. The status is checked before any body is read: the 404s of the
// site are HTML. A network failure, a timeout or a 5xx is WEBHOST_UNAVAILABLE.
import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { WebRoomRef } from '@shared/types'
import type { CoreContext } from '../context'
import type { CookieJarStore } from './cookies'

/** What `/api/room_status/<room>` says, renamed. Its `downloads` paths are relative to the site. */
export interface RoomStatus {
  /** The tracker's suuid. */
  tracker: string | null
  players: { name: string; game: string }[]
  /** 0 before the first start, -1 after an error; the port can change when the room wakes up. */
  lastPort: number
  /** As the site gives it (an HTTP date). */
  lastActivity: string | null
  /** Idle seconds before the room shuts down. */
  timeoutS: number | null
  downloads: { slot: number; download: string }[]
}

export interface WebhostClient {
  /** The site, as configured (`https://archipelago.gg`, or the fake site of the tests). */
  readonly baseUrl: string
  /** POST /uploads (field `file`); the seed's suuid from the 302 to /seed/<id>. */
  uploadSeed(zipPath: string, signal?: AbortSignal): Promise<string>
  /** GET /new_room/<seed>: creates a NEW room on every call (never retried); its suuid from the 302. */
  createRoom(seedId: string, signal?: AbortSignal): Promise<string>
  /** GET /room/<room>?update: starts the room again when it sleeps. */
  wake(roomId: string, signal?: AbortSignal): Promise<void>
  /** GET /api/room_status/<room>; does not wake the room. NOT_FOUND for an unknown room. */
  roomStatus(roomId: string, signal?: AbortSignal): Promise<RoomStatus>
  /** POST /room/<room>, form field `cmd`: a console command (the site ignores non-owners silently). */
  sendCommand(roomId: string, cmd: string): Promise<void>
  /** GET /log/<room> from `fromByte` (`Range: bytes=N-`), owner only. */
  readLog(roomId: string, fromByte: number): Promise<{ text: string; nextByte: number }>
  /** GET /api/get_rooms: the rooms of the app's identity. */
  myRooms(): Promise<WebRoomRef[]>
  /**
   * The `/session/<uuid>` URL that gives a browser the app's identity, read from GET /session. The
   * site shows a page there and does not redirect: the caller opens the room next. The UUID is a
   * credential: never log the URL.
   */
  ownerUrl(roomId: string): Promise<string>
}

export interface WebhostClientOptions {
  baseUrl: string
  jar: CookieJarStore
  /** Whole-request deadline, body included. Default 30 s. */
  timeoutMs?: number
  /** Deadline of the upload, whose body can take minutes on a slow uplink. Default 10 min. */
  uploadTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000
/** An suuid is 22 URL-safe base64 characters; anything else could reach another route. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_LINK_RE = /\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
/** The text AP answers (200, even with a Range) while a room's log file does not exist yet. */
const NO_LOG_FILE_RE = /^Logfile \S+ does not exist\./

// --- pure helpers ---------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/**
 * The flash messages of a page of the site (`<div class="user-message">`, what an upload error
 * shows), as plain text, one per line; null when there is none.
 */
export function parseUserMessage(html: string): string | null {
  const messages: string[] = []
  const re = /<div\s+class="[^"]*\buser-message\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  for (const match of html.matchAll(re)) {
    const text = decodeEntities((match[1] ?? '').replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    if (text !== '') messages.push(text)
  }
  return messages.length > 0 ? messages.join('\n') : null
}

/**
 * `rel` resolved against `base`. The site may give http:// URLs: they become https:// when the site
 * itself is https and the URL is on its host; the local fake site (plain http) keeps its URLs.
 */
export function normalizeWebUrl(base: string, rel: string): string {
  const site = new URL(base)
  const url = new URL(rel, site)
  if (site.protocol === 'https:' && url.protocol === 'http:' && url.hostname === site.hostname) {
    url.protocol = 'https:'
  }
  return url.href
}

/** The length of `bytes` without an unfinished UTF-8 character at its end (kept for the next read). */
function completeUtf8Length(bytes: Uint8Array): number {
  let start = bytes.length - 1
  while (start >= 0 && bytes.length - start < 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1
  if (start < 0) return bytes.length
  const lead = bytes[start] ?? 0
  const size = lead >= 0xf0 && lead < 0xf8 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return bytes.length - start < size ? start : bytes.length
}

// --- answers --------------------------------------------------------------------------------------

const Text = z.string()
const RoomStatusSchema = z.object({
  tracker: Text.nullish(),
  players: z.array(z.tuple([Text, Text]).rest(z.unknown())),
  last_port: z.number().int(),
  last_activity: Text.nullish(),
  timeout: z.number().nullish(),
  downloads: z.array(z.object({ slot: z.number().int(), download: Text })).nullish(),
})
const RoomRefSchema = z.object({
  room_id: Text.regex(ID_RE),
  seed_id: Text.nullish(),
  last_activity: Text.nullish(),
})

/** An HTTP date (as Flask writes them) as ISO 8601; null when it is not a date. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new AppError('INVALID_INPUT', undefined, { detail: 'not an archipelago.gg id' })
  return id
}

const unavailable = (detail: string, cause?: unknown): AppError =>
  new AppError('WEBHOST_UNAVAILABLE', undefined, { detail, cause })

/** A status the site was not expected to answer: NOT_FOUND for a 404, HTTP_ERROR otherwise. */
function unexpected(res: Response, url: string): AppError {
  if (res.status === 404) return new AppError('NOT_FOUND', undefined, { detail: new URL(url).pathname })
  return new AppError('HTTP_ERROR', { status: res.status, url })
}

/** The id at the end of a redirect to `/<kind>/<id>`; null for any other answer. */
function redirectedId(res: Response, base: string, kind: 'seed' | 'room'): string | null {
  const location = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !location) return null
  const match = new RegExp(`^/${kind}/([A-Za-z0-9_-]+)$`).exec(
    new URL(normalizeWebUrl(base, location)).pathname,
  )
  return match?.[1] ?? null
}

const discard = async (res: Response): Promise<void> => {
  await res.body?.cancel().catch(() => undefined)
}

// --- the client -----------------------------------------------------------------------------------

interface Exchange {
  method?: 'GET' | 'POST'
  body?: FormData | URLSearchParams
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** Answers 5xx with something else than WEBHOST_UNAVAILABLE (the upload's own errors). */
  serverError?: (res: Response) => AppError | null
}

export function createWebhostClient(
  ctx: Pick<CoreContext, 'http'>,
  opts: WebhostClientOptions,
): WebhostClient {
  const { baseUrl, jar } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS

  /**
   * One request and the reading of its answer by `read`, under one deadline. The cookies of the
   * answer are kept whatever its status. Errors: `read`'s own AppErrors as they are, TASK_CANCELLED
   * when `signal` fired, WEBHOST_UNAVAILABLE for anything else (network, timeout, 5xx, a body that
   * broke).
   */
  async function exchange<T>(
    path: string,
    init: Exchange,
    read: (res: Response, url: string) => Promise<T>,
  ): Promise<T> {
    let url: string
    try {
      url = normalizeWebUrl(baseUrl, path)
    } catch (cause) {
      throw new AppError('INVALID_INPUT', undefined, { detail: 'webhost URL', cause })
    }
    const outer = init.signal
    const limit = init.timeoutMs ?? timeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limit)
    const onAbort = (): void => controller.abort(outer?.reason)
    if (outer?.aborted) controller.abort(outer.reason)
    else outer?.addEventListener('abort', onAbort, { once: true })

    try {
      const headers: Record<string, string> = { 'accept-encoding': 'gzip, br', ...init.headers }
      const cookie = jar.cookieHeader(url)
      if (cookie !== '') headers.cookie = cookie
      const res = await ctx.http.fetchRaw(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'manual',
        signal: controller.signal,
        timeoutMs: limit,
      })
      jar.store(url, res.headers.getSetCookie())
      if (res.status >= 500) {
        await discard(res)
        throw init.serverError?.(res) ?? unavailable(`status ${res.status}`)
      }
      return await read(res, url)
    } catch (error) {
      if (outer?.aborted) throw new AppError('TASK_CANCELLED', undefined, { cause: error })
      const passes =
        error instanceof AppError && error.code !== 'NETWORK_OFFLINE' && error.code !== 'TASK_CANCELLED'
      if (passes && !timedOut) throw error
      throw unavailable(timedOut ? 'timeout' : error instanceof Error ? error.message : String(error), error)
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  /** A JSON body (the status was checked first); WEBHOST_UNAVAILABLE when it is not what `schema` wants. */
  async function readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    const text = await res.text()
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (cause) {
      throw unavailable('invalid JSON', cause)
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw unavailable('unexpected JSON')
    return parsed.data
  }

  /** An answer whose body is not needed: `ok` statuses pass, the others fail. */
  async function expectStatus(res: Response, url: string, ok: (status: number) => boolean): Promise<void> {
    await discard(res)
    if (!ok(res.status)) throw unexpected(res, url)
  }

  return {
    baseUrl,

    async uploadSeed(zipPath, signal) {
      if (signal?.aborted) throw new AppError('TASK_CANCELLED')
      const file = await stat(zipPath).catch(() => null)
      if (!file?.isFile()) throw new AppError('NOT_FOUND', undefined, { detail: basename(zipPath) })
      const form = new FormData()
      form.append('file', await openAsBlob(zipPath, { type: 'application/zip' }), basename(zipPath))
      return exchange(
        '/uploads',
        {
          method: 'POST',
          body: form,
          signal,
          timeoutMs: uploadTimeoutMs,
          // A ROM inside the zip makes the site fail with a 500 (research brief §1.8): a rejected file.
          serverError: (res) =>
            res.status === 500
              ? new AppError('WEBHOST_UPLOAD_FAILED', undefined, { detail: 'status 500' })
              : null,
        },
        async (res) => {
          const seedId = redirectedId(res, baseUrl, 'seed')
          if (seedId !== null) {
            await discard(res)
            return seedId
          }
          if (res.status !== 200) {
            await discard(res)
            const params = res.status === 413 ? { reason: 'too-large' } : undefined
            throw new AppError('WEBHOST_UPLOAD_FAILED', params, { detail: `status ${res.status}` })
          }
          // The site's errors are flash messages on a 200 page.
          const message = parseUserMessage(await res.text())
          throw message === null
            ? new AppError('WEBHOST_UPLOAD_FAILED', undefined, { detail: 'status 200' })
            : new AppError('WEBHOST_UPLOAD_FAILED', { message }, { detail: message })
        },
      )
    },

    async createRoom(seedId, signal) {
      assertId(seedId)
      return exchange(`/new_room/${seedId}`, { signal }, async (res) => {
        await discard(res)
        const roomId = redirectedId(res, baseUrl, 'room')
        if (roomId === null)
          throw new AppError('WEBHOST_ROOM_FAILED', undefined, { detail: `status ${res.status}` })
        return roomId
      })
    },

    async wake(roomId, signal) {
      assertId(roomId)
      await exchange(`/room/${roomId}?update`, { signal }, (res, url) =>
        expectStatus(res, url, (status) => status >= 200 && status < 300),
      )
    },

    async roomStatus(roomId, signal) {
      assertId(roomId)
      return exchange(
        `/api/room_status/${roomId}`,
        { signal, headers: { accept: 'application/json' } },
        async (res, url) => {
          if (res.status !== 200) {
            await discard(res)
            throw unexpected(res, url)
          }
          const raw = await readJson(res, RoomStatusSchema)
          return {
            tracker: raw.tracker ?? null,
            players: raw.players.map(([name, game]) => ({ name, game })),
            lastPort: raw.last_port,
            lastActivity: raw.last_activity ?? null,
            timeoutS: raw.timeout ?? null,
            downloads: raw.downloads ?? [],
          }
        },
      )
    },

    async sendCommand(roomId, cmd) {
      assertId(roomId)
      await exchange(
        `/room/${roomId}`,
        { method: 'POST', body: new URLSearchParams({ cmd }) },
        // The site answers with a redirect to the room, which is not followed.
        (res, url) => expectStatus(res, url, (status) => status >= 200 && status < 400),
      )
    },

    async readLog(roomId, fromByte) {
      assertId(roomId)
      return exchange(`/log/${roomId}`, { headers: { range: `bytes=${fromByte}-` } }, async (res, url) => {
        if (res.status !== 200 && res.status !== 206) {
          await discard(res)
          throw unexpected(res, url)
        }
        let bytes = new Uint8Array(await res.arrayBuffer())
        if (res.status === 200) {
          // No range served: the log file does not exist yet, or the whole log came back.
          if (NO_LOG_FILE_RE.test(new TextDecoder().decode(bytes.subarray(0, 512)))) {
            return { text: '', nextByte: fromByte }
          }
          bytes = bytes.subarray(Math.min(fromByte, bytes.length))
        }
        const end = completeUtf8Length(bytes)
        return { text: new TextDecoder().decode(bytes.subarray(0, end)), nextByte: fromByte + end }
      })
    },

    async myRooms() {
      return exchange('/api/get_rooms', { headers: { accept: 'application/json' } }, async (res, url) => {
        if (res.status !== 200) {
          await discard(res)
          throw unexpected(res, url)
        }
        const rows = await readJson(res, z.array(z.unknown()))
        return rows.flatMap((row) => {
          const parsed = RoomRefSchema.safeParse(row)
          if (!parsed.success) return []
          const { room_id: roomId, seed_id: seedId, last_activity: lastActivity } = parsed.data
          return [
            {
              roomId,
              seedId: seedId ?? null,
              roomUrl: normalizeWebUrl(baseUrl, `/room/${roomId}`),
              lastActivity: toIsoDate(lastActivity),
            },
          ]
        })
      })
    },

    async ownerUrl(roomId) {
      assertId(roomId)
      return exchange('/session', {}, async (res, url) => {
        if (res.status !== 200) {
          await discard(res)
          throw unexpected(res, url)
        }
        const uuid = SESSION_LINK_RE.exec(await res.text())?.[1]
        if (uuid === undefined) throw unavailable('no identity on /session')
        return normalizeWebUrl(baseUrl, `/session/${uuid.toLowerCase()}`)
      })
    },
  }
}

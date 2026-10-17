// The HTTP client of the main process (the `Http` of CoreContext). Everything the app fetches goes
// through it: one user agent, one timeout policy, the same error codes, and an ETag cache that also
// answers when the network is down. Core code never imports 'electron': it runs on Node's `fetch`.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { Http, HttpAnswer, HttpGetOptions } from '../context'
import type { Logger } from '../logger'
import { writeFileAtomic } from './fsx'

export interface HttpOptions {
  /** `apUserAgent(version)`: sent with every request. */
  userAgent: string
  /** Where `http-cache.json` and the cached bodies live (dataRoot/catalog). */
  cacheDir: string
  log: Logger
  /** Read for every request to api.github.com; null (or a throw) means anonymous. */
  githubToken: () => string | null
  /** Replaces the global `fetch`. The tests use it to send api.github.com to a local server. */
  fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000
const GITHUB_API_HOST = 'api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
/** GitHub's primary rate-limit window: the guess for `resetAt` when an answer does not say. */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

/** `ArchipelaGOAT/<version> (unofficial Archipelago companion)`. */
export function apUserAgent(version: string): string {
  return `ArchipelaGOAT/${version} (unofficial Archipelago companion)`
}

function parseHttpUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'not a URL', cause })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_INPUT', undefined, { detail: `unsupported protocol ${parsed.protocol}` })
  }
  return parsed
}

/** The only place the GitHub token goes: https, that host, the default port. */
const isGithubApi = (url: URL): boolean => url.protocol === 'https:' && url.host === GITHUB_API_HOST

// --- errors ---------------------------------------------------------------------------------------

/** `ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`… when there is one: `fetch failed` says nothing. */
function describeFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  for (const candidate of [cause, error]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code
    if (typeof code === 'string' && code !== '') return code
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * What a failed `fetch` (or a body that broke on the way) means: `TASK_CANCELLED` when the caller's
 * signal fired, `NETWORK_OFFLINE` otherwise (a timeout included: from here it is the same thing).
 */
export function toNetworkError(
  error: unknown,
  how: { signal?: AbortSignal | null; timedOut?: boolean } = {},
): AppError {
  if (error instanceof AppError) return error
  if (how.signal?.aborted) return new AppError('TASK_CANCELLED', undefined, { cause: error })
  const detail = how.timedOut ? 'timeout' : describeFailure(error)
  return new AppError('NETWORK_OFFLINE', undefined, { detail, cause: error })
}

/**
 * The error of an answer with a status of 400 or more. GitHub tells a rate limit apart by
 * `x-ratelimit-remaining: 0` on a 403 or a 429; `resetAt` is then the reset time in epoch ms.
 */
export function httpStatusError(res: Response, url: string): AppError {
  const limited =
    (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining')?.trim() === '0'
  if (limited) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    return new AppError('GITHUB_RATE_LIMITED', {
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + RATE_LIMIT_WINDOW_MS,
    })
  }
  return new AppError('HTTP_ERROR', { status: res.status, url })
}

// --- timeout and cancellation -----------------------------------------------------------------------

interface Deadline {
  /** Aborts when the timeout is over or when the caller's signal fires. */
  signal: AbortSignal
  readonly timedOut: boolean
  /** The headers are in: what follows (a long download) is not under the timeout any more. */
  headersReceived(): void
  /** Ends the timer and stops listening to the caller's signal. */
  release(): void
}

function startDeadline(timeoutMs: number, outer?: AbortSignal | null): Deadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onOuterAbort = (): void => controller.abort(outer?.reason)
  if (outer?.aborted) controller.abort(outer.reason)
  else outer?.addEventListener('abort', onOuterAbort, { once: true })
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    headersReceived: () => clearTimeout(timer),
    release: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}

// --- the ETag cache -----------------------------------------------------------------------------

interface CacheEntry {
  url: string
  etag: string | null
}

interface CachedAnswer {
  etag: string | null
  body: string
}

/**
 * `cacheDir/http-cache.json` maps a cache key to the URL and ETag it was stored for; each body is
 * its own file under `cacheDir/http-cache/`. Reading is forgiving (a missing or corrupted file is an
 * empty cache) and writing never fails a request: the cache is an optimisation, not a source of truth.
 */
function createCache(dir: string, log: Logger) {
  const indexFile = join(dir, 'http-cache.json')
  const bodyFile = (key: string): string =>
    join(dir, 'http-cache', `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.body`)

  async function readIndex(): Promise<Map<string, CacheEntry>> {
    const entries = new Map<string, CacheEntry>()
    try {
      const raw = JSON.parse(await readFile(indexFile, 'utf8')) as { entries?: unknown } | null
      if (typeof raw?.entries === 'object' && raw.entries !== null) {
        for (const [key, value] of Object.entries(raw.entries)) {
          const entry = value as Partial<CacheEntry> | null
          if (typeof entry?.url === 'string' && (entry.etag === null || typeof entry.etag === 'string')) {
            entries.set(key, { url: entry.url, etag: entry.etag })
          }
        }
      }
    } catch {
      // No file yet, or one that is not valid JSON: start empty, the next store rewrites it.
    }
    return entries
  }

  let index: Promise<Map<string, CacheEntry>> | null = null
  const load = (): Promise<Map<string, CacheEntry>> => (index ??= readIndex())
  let writes: Promise<void> = Promise.resolve()

  return {
    /** What is cached under `key` for this very `url`; null when there is no body to serve with it. */
    async lookup(key: string, url: string): Promise<CachedAnswer | null> {
      const entry = (await load()).get(key)
      if (!entry || entry.url !== url) return null
      try {
        return { etag: entry.etag, body: await readFile(bodyFile(key), 'utf8') }
      } catch {
        return null
      }
    },

    /** Stores the answer; the writes of concurrent requests run one after the other. */
    store(key: string, url: string, etag: string | null, body: string): Promise<void> {
      const write = async (): Promise<void> => {
        try {
          const entries = await load()
          await writeFileAtomic(bodyFile(key), body)
          entries.set(key, { url, etag })
          await writeFileAtomic(
            indexFile,
            JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }),
          )
        } catch (error) {
          log.warn('http cache: could not write', error)
        }
      }
      writes = writes.then(write)
      return writes
    },
  }
}

// --- the client ---------------------------------------------------------------------------------

type Parse<T> = (text: string, status: number) => T

export function createHttp(opts: HttpOptions): Http {
  const { userAgent, log } = opts
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const cache = createCache(opts.cacheDir, log)

  const readToken = (): string | null => {
    try {
      return opts.githubToken()
    } catch {
      return null
    }
  }

  /**
   * The user agent, then for api.github.com its media type, version and the token, then `defaults`
   * for what is still unset, then what the caller adds (which wins).
   */
  function requestHeaders(
    target: URL,
    defaults: Record<string, string>,
    extra?: RequestInit['headers'],
  ): Headers {
    const headers = new Headers({ 'user-agent': userAgent })
    if (isGithubApi(target)) {
      headers.set('accept', 'application/vnd.github+json')
      headers.set('x-github-api-version', GITHUB_API_VERSION)
      const token = readToken()
      if (token) headers.set('authorization', `Bearer ${token}`)
    }
    for (const [name, value] of Object.entries(defaults)) {
      if (!headers.has(name)) headers.set(name, value)
    }
    new Headers(extra).forEach((value, name) => headers.set(name, value))
    return headers
  }

  /**
   * GET with the ETag cache. A 304 serves the cached body; a network failure serves it too when there
   * is one, and then the answer is marked `stale`. Any other failure (an HTTP status, a body that
   * does not parse) is thrown: a server that answered is not a network that failed.
   */
  async function cachedGet<T>(
    url: string,
    getOpts: HttpGetOptions,
    parse: Parse<T>,
    defaults: Record<string, string>,
  ): Promise<HttpAnswer<T>> {
    const target = parseHttpUrl(url)
    const key = getOpts.cacheKey ?? url
    const cached = await cache.lookup(key, url)
    const headers = requestHeaders(
      target,
      cached?.etag ? { ...defaults, 'if-none-match': cached.etag } : defaults,
      getOpts.headers,
    )

    const deadline = startDeadline(getOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let res: Response
    let body: string | null = null
    try {
      res = await doFetch(target, { headers, signal: deadline.signal })
      // The timeout covers the body too: a server that stalls after its headers is a failed network.
      if (res.ok) body = await res.text()
    } catch (error) {
      const failure = toNetworkError(error, { timedOut: deadline.timedOut })
      if (cached && failure.code === 'NETWORK_OFFLINE') {
        log.warn('network failure, serving the cached answer', { url, reason: failure.detail })
        return { data: parse(cached.body, 200), fromCache: true, stale: true }
      }
      throw failure
    } finally {
      deadline.release()
    }

    if (res.status === 304 && cached) {
      await res.body?.cancel().catch(() => undefined)
      return { data: parse(cached.body, 200), fromCache: true }
    }
    if (body === null) {
      await res.body?.cancel().catch(() => undefined)
      throw httpStatusError(res, url)
    }
    // Parsed before it is stored: an answer that does not parse (a captive portal) is never cached.
    const data = parse(body, res.status)
    await cache.store(key, url, res.headers.get('etag'), body)
    return { data, fromCache: false }
  }

  return {
    getJson<T>(url: string, getOpts: HttpGetOptions = {}) {
      return cachedGet<T>(
        url,
        getOpts,
        (text, status) => {
          try {
            return JSON.parse(text) as T
          } catch (cause) {
            throw new AppError('HTTP_ERROR', { status, url }, { detail: 'invalid JSON', cause })
          }
        },
        { accept: 'application/json' },
      )
    },

    getText(url: string, getOpts: HttpGetOptions = {}) {
      return cachedGet(url, getOpts, (text) => text, {})
    },

    /**
     * No cache and no status mapping: the caller gets the Response, whatever its status. The timeout
     * ends when the headers arrive; `init.signal` keeps working on the body.
     */
    async fetchRaw(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
      const target = parseHttpUrl(url)
      const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, signal, ...rest } = init
      const deadline = startDeadline(timeoutMs, signal)
      try {
        const res = await doFetch(target, {
          ...rest,
          headers: requestHeaders(target, {}, headers),
          signal: deadline.signal,
        })
        deadline.headersReceived()
        return res
      } catch (error) {
        deadline.release()
        throw toNetworkError(error, { signal, timedOut: deadline.timedOut })
      }
    },
  }
}

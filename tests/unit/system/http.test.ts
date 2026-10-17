import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@main/core/logger'
import { apUserAgent, createHttp } from '@main/core/system/http'
import { AppError } from '@shared/errors'
import {
  dropConnection,
  fetchVia,
  reply,
  startTestServer,
  type RequestHandler,
  type TestServer,
} from '../../helpers/http-server'
import { silentLogger } from '../../helpers/core'

const GITHUB_HOSTS = ['api.github.com', 'github.com', 'raw.githubusercontent.com']
const hang: RequestHandler = () => undefined

let root: string
let cacheDir: string
let server: TestServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat http é-'))
  cacheDir = join(root, 'catalog')
  server = await startTestServer((_req, res) => reply(res, 404))
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

function makeHttp(extra: Partial<Parameters<typeof createHttp>[0]> = {}): ReturnType<typeof createHttp> {
  return createHttp({
    userAgent: 'Test/1.0 (unit)',
    cacheDir,
    log: silentLogger,
    githubToken: () => null,
    ...extra,
  })
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

const json = (value: unknown): string => JSON.stringify(value)
const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  ...extra,
})

describe('apUserAgent', () => {
  it('names the app, its version and its unofficial status', () => {
    expect(apUserAgent('1.2.3')).toBe('ArchipelaGOAT/1.2.3 (unofficial Archipelago companion)')
  })
})

describe('getJson and getText', () => {
  it('parses JSON and sends the user agent', async () => {
    server.handle((_req, res) => reply(res, 200, json({ n: 1 }), jsonHeaders()))
    const result = await makeHttp().getJson<{ n: number }>(`${server.url}/data`)
    expect(result).toEqual({ data: { n: 1 }, fromCache: false })
    expect(server.requests[0]?.headers['user-agent']).toBe('Test/1.0 (unit)')
    expect(server.requests[0]?.headers.accept).toBe('application/json')
  })

  it('returns the text as it is, UTF-8 included', async () => {
    server.handle((_req, res) => reply(res, 200, 'Jérôme\nline 2'))
    const result = await makeHttp().getText(`${server.url}/text`)
    expect(result).toEqual({ data: 'Jérôme\nline 2', fromCache: false })
  })

  it('lets the caller add and override headers', async () => {
    server.handle((_req, res) => reply(res, 200, '{}'))
    await makeHttp().getJson(`${server.url}/x`, { headers: { accept: 'application/x-test', 'x-extra': '1' } })
    expect(server.requests[0]?.headers.accept).toBe('application/x-test')
    expect(server.requests[0]?.headers['x-extra']).toBe('1')
  })

  it('refuses a URL that is not http or https', async () => {
    const http = makeHttp()
    for (const url of ['file:///etc/passwd', 'ftp://example.test/x', 'not a url']) {
      expect((await failure(http.getText(url))).code).toBe('INVALID_INPUT')
      expect((await failure(http.fetchRaw(url))).code).toBe('INVALID_INPUT')
    }
    expect(server.requests).toHaveLength(0)
  })

  it('maps an invalid JSON answer to HTTP_ERROR and does not cache it', async () => {
    server.handle((_req, res) => reply(res, 200, '<html>captive portal</html>', { etag: '"p"' }))
    const http = makeHttp()
    const error = await failure(http.getJson(`${server.url}/data`))
    expect(error.code).toBe('HTTP_ERROR')
    expect(error.params).toEqual({ status: 200, url: `${server.url}/data` })
    server.handle(dropConnection)
    expect((await failure(http.getJson(`${server.url}/data`))).code).toBe('NETWORK_OFFLINE')
  })
})

describe('the ETag cache', () => {
  it('sends If-None-Match and serves the cached body on 304', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 200, json({ n: 1 }), { etag: '"v1"' }))
    expect(await http.getJson(`${server.url}/data`)).toEqual({ data: { n: 1 }, fromCache: false })

    server.handle((req, res) =>
      req.headers['if-none-match'] === '"v1"' ? reply(res, 304) : reply(res, 200, json({ n: 99 })),
    )
    const confirmed = await http.getJson(`${server.url}/data`)
    expect(confirmed).toEqual({ data: { n: 1 }, fromCache: true })
    expect(confirmed.stale).toBeUndefined() // the server answered: a 304 is as fresh as a 200
    expect(server.requests[1]?.headers['if-none-match']).toBe('"v1"')
  })

  it('replaces the cache when the resource changes', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 200, json({ n: 1 }), { etag: '"v1"' }))
    await http.getText(`${server.url}/data`)
    server.handle((_req, res) => reply(res, 200, json({ n: 2 }), { etag: '"v2"' }))
    expect((await http.getJson(`${server.url}/data`)).fromCache).toBe(false)

    server.handle((req, res) => (req.headers['if-none-match'] === '"v2"' ? reply(res, 304) : reply(res, 500)))
    expect(await http.getJson(`${server.url}/data`)).toEqual({ data: { n: 2 }, fromCache: true })
  })

  it('serves the cached body when the network fails, also after a restart', async () => {
    server.handle((_req, res) => reply(res, 200, json({ n: 1 }), { etag: '"v1"' }))
    await makeHttp().getJson(`${server.url}/data`)

    server.handle(dropConnection)
    expect(await makeHttp().getJson(`${server.url}/data`)).toEqual({
      data: { n: 1 },
      fromCache: true,
      stale: true,
    })
    expect(await makeHttp().getText(`${server.url}/data`)).toEqual({
      data: '{"n":1}',
      fromCache: true,
      stale: true,
    })
  })

  it('caches an answer that has no ETag, for the offline case only', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 200, json({ n: 1 })))
    await http.getJson(`${server.url}/data`)
    expect(server.requests[0]?.headers['if-none-match']).toBeUndefined()

    await http.getJson(`${server.url}/data`)
    expect(server.requests[1]?.headers['if-none-match']).toBeUndefined()

    server.handle(dropConnection)
    const offline = await http.getJson(`${server.url}/data`)
    expect(offline.fromCache).toBe(true)
    expect(offline.stale).toBe(true)
  })

  it('throws NETWORK_OFFLINE when the network fails and nothing is cached', async () => {
    server.handle(dropConnection)
    const error = await failure(makeHttp().getJson(`${server.url}/data`))
    expect(error.code).toBe('NETWORK_OFFLINE')
    expect(error.cause).toBeDefined()
  })

  it('keeps one entry per cacheKey and never serves an entry cached for another URL', async () => {
    const http = makeHttp()
    server.handle((req, res) => reply(res, 200, `body of ${req.url}`, { etag: `"${req.url}"` }))
    await http.getText(`${server.url}/a`, { cacheKey: 'one' })
    await http.getText(`${server.url}/b`, { cacheKey: 'two' })
    // The same key, another URL: the cached ETag is not offered, the answer is not taken for it.
    await http.getText(`${server.url}/c`, { cacheKey: 'one' })
    expect(server.requests.map((r) => r.headers['if-none-match'])).toEqual([undefined, undefined, undefined])

    server.handle(dropConnection)
    expect((await http.getText(`${server.url}/b`, { cacheKey: 'two' })).data).toBe('body of /b')
    expect((await http.getText(`${server.url}/c`, { cacheKey: 'one' })).data).toBe('body of /c')
    expect((await failure(http.getText(`${server.url}/a`, { cacheKey: 'one' }))).code).toBe('NETWORK_OFFLINE')
  })

  it('writes http-cache.json with the ETag and the body in a separate file', async () => {
    server.handle((_req, res) => reply(res, 200, 'a distinctive body', { etag: '"tag-1"' }))
    await makeHttp().getText(`${server.url}/data`)

    const index = readFileSync(join(cacheDir, 'http-cache.json'), 'utf8')
    expect(JSON.parse(index)).toMatchObject({
      entries: { [`${server.url}/data`]: { url: `${server.url}/data`, etag: '"tag-1"' } },
    })
    expect(index).not.toContain('a distinctive body')
    const bodies = readdirSync(cacheDir, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name !== 'http-cache.json',
    )
    expect(bodies).toHaveLength(1)
    expect(readFileSync(join(bodies[0]?.parentPath ?? '', bodies[0]?.name ?? ''), 'utf8')).toBe(
      'a distinctive body',
    )
  })

  it('ignores a corrupted index and rewrites it', async () => {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'http-cache.json'), '{ not json')
    server.handle((_req, res) => reply(res, 200, '{}', { etag: '"v1"' }))
    expect((await makeHttp().getJson(`${server.url}/data`)).fromCache).toBe(false)
    expect(JSON.parse(readFileSync(join(cacheDir, 'http-cache.json'), 'utf8'))).toBeTypeOf('object')

    server.handle(dropConnection)
    expect((await makeHttp().getJson(`${server.url}/data`)).fromCache).toBe(true)
  })

  it('does not offer an ETag whose body is gone, since a 304 could not be served', async () => {
    server.handle((_req, res) => reply(res, 200, '{}', { etag: '"v1"' }))
    await makeHttp().getJson(`${server.url}/data`)
    rmSync(cacheDir, { recursive: true, force: true })
    mkdirSync(cacheDir, { recursive: true })
    // The index is back but every body is missing.
    writeFileSync(
      join(cacheDir, 'http-cache.json'),
      json({ version: 1, entries: { [`${server.url}/data`]: { url: `${server.url}/data`, etag: '"v1"' } } }),
    )

    expect((await makeHttp().getJson(`${server.url}/data`)).fromCache).toBe(false)
    expect(server.requests[1]?.headers['if-none-match']).toBeUndefined()
  })

  it('answers a 304 it did not ask for with HTTP_ERROR', async () => {
    server.handle((_req, res) => reply(res, 304))
    const error = await failure(makeHttp().getText(`${server.url}/data`))
    expect(error.code).toBe('HTTP_ERROR')
    expect(error.params).toMatchObject({ status: 304 })
  })

  it('still answers when the cache cannot be written', async () => {
    const warn = vi.fn<Logger['warn']>()
    const blocker = join(root, 'a-file')
    writeFileSync(blocker, 'x')
    const http = makeHttp({
      cacheDir: join(blocker, 'catalog'),
      log: { ...silentLogger, warn },
    })
    server.handle((_req, res) => reply(res, 200, json({ ok: true }), { etag: '"v1"' }))
    expect(await http.getJson(`${server.url}/data`)).toEqual({ data: { ok: true }, fromCache: false })
    expect(warn).toHaveBeenCalled()
  })
})

describe('error mapping', () => {
  it('maps a 403 with x-ratelimit-remaining 0 to GITHUB_RATE_LIMITED with resetAt in ms', async () => {
    server.handle((_req, res) =>
      reply(res, 403, json({ message: 'API rate limit exceeded' }), {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1790000000',
      }),
    )
    const error = await failure(makeHttp().getJson(`${server.url}/x`))
    expect(error.code).toBe('GITHUB_RATE_LIMITED')
    expect(error.params).toEqual({ resetAt: 1_790_000_000_000 })
  })

  it('maps a 429 with x-ratelimit-remaining 0 the same way', async () => {
    server.handle((_req, res) =>
      reply(res, 429, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000123' }),
    )
    const error = await failure(makeHttp().getText(`${server.url}/x`))
    expect(error.code).toBe('GITHUB_RATE_LIMITED')
    expect(error.params).toEqual({ resetAt: 1_790_000_123_000 })
  })

  it('gives a resetAt in the future when the reset header is missing', async () => {
    server.handle((_req, res) => reply(res, 403, '', { 'x-ratelimit-remaining': '0' }))
    const error = await failure(makeHttp().getText(`${server.url}/x`))
    expect(error.code).toBe('GITHUB_RATE_LIMITED')
    expect(error.params?.resetAt).toBeGreaterThan(Date.now())
  })

  it('does not take a 403 with requests left for a rate limit', async () => {
    server.handle((_req, res) => reply(res, 403, '', { 'x-ratelimit-remaining': '12' }))
    const error = await failure(makeHttp().getText(`${server.url}/x`))
    expect(error.code).toBe('HTTP_ERROR')
    expect(error.params).toEqual({ status: 403, url: `${server.url}/x` })
  })

  it.each([404, 410, 500, 503])('maps status %i to HTTP_ERROR{status,url}', async (status) => {
    server.handle((_req, res) => reply(res, status, 'nope'))
    const error = await failure(makeHttp().getJson(`${server.url}/missing`))
    expect(error.code).toBe('HTTP_ERROR')
    expect(error.params).toEqual({ status, url: `${server.url}/missing` })
  })

  it('does not serve the cache for an HTTP error, only for a network failure', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 200, '{}', { etag: '"v1"' }))
    await http.getJson(`${server.url}/data`)
    server.handle((_req, res) => reply(res, 500))
    expect((await failure(http.getJson(`${server.url}/data`))).code).toBe('HTTP_ERROR')
  })
})

describe('timeouts and cancellation', () => {
  it('times out a server that never answers, as a network failure', async () => {
    server.handle(hang)
    const error = await failure(makeHttp().getText(`${server.url}/x`, { timeoutMs: 80 }))
    expect(error.code).toBe('NETWORK_OFFLINE')
    expect(error.detail).toBe('timeout')
  })

  it('also times out a body that stalls, and serves the cache then', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 200, 'cached', { etag: '"v1"' }))
    await http.getText(`${server.url}/x`)

    server.handle((_req, res) => {
      res.writeHead(200, { 'content-length': 100 })
      res.write('partial')
    })
    expect(await http.getText(`${server.url}/x`, { timeoutMs: 80 })).toEqual({
      data: 'cached',
      fromCache: true,
      stale: true,
    })
  })

  it('fetchRaw times out on the headers only, so a slow body still arrives', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-length': 8 })
      res.write('slow')
      setTimeout(() => res.end('body'), 250)
    })
    const response = await makeHttp().fetchRaw(`${server.url}/x`, { timeoutMs: 100 })
    expect(await response.text()).toBe('slowbody')
  })

  it('fetchRaw times out when no header comes', async () => {
    server.handle(hang)
    const error = await failure(makeHttp().fetchRaw(`${server.url}/x`, { timeoutMs: 80 }))
    expect(error.code).toBe('NETWORK_OFFLINE')
    expect(error.detail).toBe('timeout')
  })

  it('fetchRaw maps an abort of the caller to TASK_CANCELLED', async () => {
    server.handle(hang)
    const controller = new AbortController()
    const pending = failure(makeHttp().fetchRaw(`${server.url}/x`, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 40)
    expect((await pending).code).toBe('TASK_CANCELLED')
  })

  it('fetchRaw does not even send a request for a signal that is already aborted', async () => {
    const error = await failure(makeHttp().fetchRaw(`${server.url}/x`, { signal: AbortSignal.abort() }))
    expect(error.code).toBe('TASK_CANCELLED')
    expect(server.requests).toHaveLength(0)
  })

  it('the abort of the caller also stops a body that is being read', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-length': 100 })
      res.write('first')
    })
    const controller = new AbortController()
    const response = await makeHttp().fetchRaw(`${server.url}/x`, { signal: controller.signal })
    const reading = response.text()
    setTimeout(() => controller.abort(), 40)
    await expect(reading).rejects.toThrow()
  })
})

describe('fetchRaw', () => {
  it('returns the response whatever its status, with neither cache nor error mapping', async () => {
    const http = makeHttp()
    server.handle((_req, res) => reply(res, 404, 'missing', { etag: '"v1"' }))
    const first = await http.fetchRaw(`${server.url}/x`)
    expect(first.status).toBe(404)
    expect(await first.text()).toBe('missing')

    server.handle((_req, res) => reply(res, 200, 'fine', { etag: '"v1"' }))
    expect(await (await http.fetchRaw(`${server.url}/x`)).text()).toBe('fine')
    expect(server.requests.map((r) => r.headers['if-none-match'])).toEqual([undefined, undefined])
    expect(() => readdirSync(cacheDir)).toThrow()
  })

  it('follows redirects unless told not to', async () => {
    server.handle((req, res) =>
      req.url === '/final' ? reply(res, 200, 'arrived') : reply(res, 302, '', { location: '/final' }),
    )
    const http = makeHttp()
    expect(await (await http.fetchRaw(`${server.url}/start`)).text()).toBe('arrived')

    const manual = await http.fetchRaw(`${server.url}/start`, { redirect: 'manual' })
    expect(manual.status).toBe(302)
    expect(manual.headers.get('location')).toBe('/final')
  })

  it('passes the method, the headers and the body of init through', async () => {
    let received = ''
    server.handle((req, res) => {
      req.on('data', (chunk: Buffer) => (received += chunk.toString()))
      req.on('end', () => reply(res, 201))
    })
    const response = await makeHttp().fetchRaw(`${server.url}/upload`, {
      method: 'POST',
      headers: { 'x-test': 'yes', 'content-type': 'text/plain' },
      body: 'payload',
    })
    expect(response.status).toBe(201)
    expect(received).toBe('payload')
    expect(server.requests[0]).toMatchObject({ method: 'POST' })
    expect(server.requests[0]?.headers['x-test']).toBe('yes')
    expect(server.requests[0]?.headers['user-agent']).toBe('Test/1.0 (unit)')
  })

  it('maps a network failure to NETWORK_OFFLINE', async () => {
    server.handle(dropConnection)
    expect((await failure(makeHttp().fetchRaw(`${server.url}/x`))).code).toBe('NETWORK_OFFLINE')
  })
})

describe('the GitHub token', () => {
  const seen = (index = 0): string | string[] | undefined => server.requests[index]?.headers.authorization

  it('is sent to api.github.com, over https, with the GitHub API headers', async () => {
    server.handle((_req, res) => reply(res, 200, '{}'))
    const http = makeHttp({ githubToken: () => 'tok-123', fetch: fetchVia(server, ...GITHUB_HOSTS) })
    await http.getJson('https://api.github.com/repos/o/r/releases/latest')
    await http.fetchRaw('https://api.github.com/rate_limit')
    for (const index of [0, 1]) {
      expect(seen(index)).toBe('Bearer tok-123')
      expect(server.requests[index]?.headers['x-github-api-version']).toBe('2022-11-28')
    }
    expect(server.requests.map((r) => r.headers.accept)).toEqual([
      'application/vnd.github+json',
      'application/vnd.github+json',
    ])
    expect(server.requests[1]?.url).toBe('/rate_limit')
  })

  it.each([
    ['another host', `__SERVER__/repos/o/r`],
    ['github.com', 'https://github.com/o/r/releases/download/1/file.exe'],
    ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/o/r/main/index.lock'],
    ['api.github.com over plain http', 'http://api.github.com/repos/o/r'],
    ['a host that only starts like it', 'https://api.github.com.evil.example/x'],
    ['api.github.com as the user name of another host', 'https://api.github.com@evil.example/x'],
    ['api.github.com on another port', 'https://api.github.com:8443/x'],
  ])('is not sent to %s', async (_label, url) => {
    server.handle((_req, res) => reply(res, 200, '{}'))
    const http = makeHttp({
      githubToken: () => 'tok-123',
      fetch: fetchVia(
        server,
        ...GITHUB_HOSTS,
        'api.github.com:8443',
        'evil.example',
        'api.github.com.evil.example',
      ),
    })
    const target = url.replace('__SERVER__', server.url)
    await http.getJson(target)
    await http.fetchRaw(target)
    expect(server.requests).toHaveLength(2)
    expect(seen(0)).toBeUndefined()
    expect(seen(1)).toBeUndefined()
  })

  it('is not sent when there is no token, and is read again for every request', async () => {
    server.handle((_req, res) => reply(res, 200, '{}'))
    let token: string | null = null
    const http = makeHttp({ githubToken: () => token, fetch: fetchVia(server, 'api.github.com') })
    await http.getJson('https://api.github.com/a')
    token = 'first'
    await http.getJson('https://api.github.com/b')
    token = 'second'
    await http.getJson('https://api.github.com/c')
    token = null
    await http.getJson('https://api.github.com/d')
    expect([0, 1, 2, 3].map((i) => seen(i))).toEqual([undefined, 'Bearer first', 'Bearer second', undefined])
  })

  it('does not break the request when the token cannot be read', async () => {
    server.handle((_req, res) => reply(res, 200, '{}'))
    const http = makeHttp({
      githubToken: () => {
        throw new Error('keyring locked')
      },
      fetch: fetchVia(server, 'api.github.com'),
    })
    await http.getJson('https://api.github.com/a')
    expect(seen()).toBeUndefined()
  })

  it('does not follow the request to another origin', async () => {
    const { port } = new URL(server.url)
    server.handle((req, res) =>
      req.url === '/redirected'
        ? reply(res, 302, '', { location: `http://localhost:${port}/final` })
        : reply(res, 200, '{}'),
    )
    const http = makeHttp({ githubToken: () => 'tok-123', fetch: fetchVia(server, 'api.github.com') })
    await http.getJson('https://api.github.com/redirected')
    expect(server.requests.map((r) => r.url)).toEqual(['/redirected', '/final'])
    expect(seen(0)).toBe('Bearer tok-123')
    expect(seen(1)).toBeUndefined()
  })
})

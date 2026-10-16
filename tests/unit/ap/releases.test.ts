import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchLatestApRelease, fetchReleaseByTag, parseRelease } from '@main/core/ap/releases'
import { createHttp } from '@main/core/system/http'
import { BIZHAWK_ASSETS } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import {
  dropConnection,
  fetchVia,
  githubFixture,
  reply,
  startTestServer,
  type TestServer,
} from '../../helpers/http-server'
import { silentLogger } from '../../helpers/core'

const fixture = githubFixture
const WIN_SHA = '416e8b34348da41e8ee6b428262e3b6b09778bf07407d4cdf0aae601bdeacaee'

function asObject(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>
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

describe('parseRelease', () => {
  it('picks the three 0.6.8 assets with sha256 from digest', () => {
    const r = parseRelease(fixture('release-0.6.8.json'))
    expect(r.version).toBe('0.6.8')
    expect(r.tag).toBe('0.6.8')
    expect(r.publishedAt).toBe('2026-10-04T16:20:11Z')
    expect(r.notes).toContain('Bug fixes and new worlds.')
    expect(r.windows?.sha256).toBe(WIN_SHA)
    expect(r.windows).toEqual({
      name: 'Setup.Archipelago.0.6.8.exe',
      url: 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8/Setup.Archipelago.0.6.8.exe',
      size: 86_208_928,
      sha256: WIN_SHA,
    })
    expect(r.linuxTarGz).toEqual({
      name: 'Archipelago_0.6.8_linux-x86_64.tar.gz',
      url: 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8/Archipelago_0.6.8_linux-x86_64.tar.gz',
      size: 122_271_814,
      sha256: 'c7ac311d8fe9c4d9c933f64be2c0b8742621e3e96b43697173157d1225017270',
    })
    expect(r.appImage).toEqual({
      name: 'Archipelago_0.6.8_linux-x86_64.AppImage',
      url: 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8/Archipelago_0.6.8_linux-x86_64.AppImage',
      size: 82_446_840,
      sha256: '1281fb7b9816bd919f9073093ceafcb3b1804143fc206bfc34b704170076240e',
    })
  })

  it('ignores apk and uses tag_name not file names', () => {
    // The fixture lists an .apk first: assets are chosen by pattern, never by position.
    const stable = parseRelease(fixture('release-0.6.8.json'))
    expect([stable.windows, stable.linuxTarGz, stable.appImage].map((a) => a?.name)).not.toContain(
      'archipelago-0.6.8-arm64-v8a-debug.apk',
    )

    // The RC: the Windows file says RC1 and the Linux ones carry the final name; only the tag tells.
    const rc = parseRelease(fixture('release-rc.json'))
    expect(rc.tag).toBe('0.6.8-rc1')
    expect(rc.version).toBe('0.6.8-rc1')
    expect(rc.windows?.name).toBe('Setup.Archipelago.0.6.8-RC1.exe')
    expect(rc.linuxTarGz?.name).toBe('Archipelago_0.6.8_linux-x86_64.tar.gz')
    expect(rc.appImage?.name).toBe('Archipelago_0.6.8_linux-x86_64.AppImage')
    expect(rc.windows?.sha256).toBe('c'.repeat(64))
  })

  it('drops a leading v from the tag to make the version', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    json.tag_name = 'v0.7.0'
    expect(parseRelease(json)).toMatchObject({ tag: 'v0.7.0', version: '0.7.0' })
  })

  it('gives null for an asset that is missing, and an empty list is fine', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    json.assets = (json.assets as { name: string }[]).filter((a) => !a.name.endsWith('.AppImage'))
    const partial = parseRelease(json)
    expect(partial.appImage).toBeNull()
    expect(partial.windows).not.toBeNull()

    json.assets = []
    expect(parseRelease(json)).toMatchObject({ windows: null, linuxTarGz: null, appImage: null })
  })

  it('gives sha256 null when there is no digest, or when it is not a sha256', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    const assets = json.assets as Record<string, unknown>[]
    const byName = (name: string): Record<string, unknown> => assets.find((a) => a.name === name) ?? {}
    delete byName('Setup.Archipelago.0.6.8.exe').digest
    byName('Archipelago_0.6.8_linux-x86_64.tar.gz').digest = 'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709'
    byName('Archipelago_0.6.8_linux-x86_64.AppImage').digest = `sha256:${'f'.repeat(63)}`

    const r = parseRelease(json)
    expect(r.windows?.sha256).toBeNull()
    expect(r.linuxTarGz?.sha256).toBeNull()
    expect(r.appImage?.sha256).toBeNull()
    expect(r.windows?.size).toBe(86_208_928)
  })

  it('lower-cases the digest', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    const windows = (json.assets as Record<string, unknown>[]).find(
      (a) => a.name === 'Setup.Archipelago.0.6.8.exe',
    )
    if (windows) windows.digest = `sha256:${WIN_SHA.toUpperCase()}`
    expect(parseRelease(json).windows?.sha256).toBe(WIN_SHA)
  })

  it('skips an asset that is malformed or not served over https', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    const assets = json.assets as Record<string, unknown>[]
    const windows = assets.find((a) => a.name === 'Setup.Archipelago.0.6.8.exe')
    if (windows) windows.browser_download_url = 'http://example.test/Setup.Archipelago.0.6.8.exe'
    assets.push({ name: 42 }, null as unknown as Record<string, unknown>, {
      name: 'Archipelago_0.6.9_linux-x86_64.tar.gz',
      browser_download_url: 'not a url',
      size: 1,
    })
    const r = parseRelease(json)
    expect(r.windows).toBeNull()
    expect(r.linuxTarGz?.name).toBe('Archipelago_0.6.8_linux-x86_64.tar.gz')
  })

  it('accepts a null body and a missing publication date', () => {
    const json = asObject(fixture('release-0.6.8.json'))
    json.body = null
    json.published_at = null
    expect(parseRelease(json)).toMatchObject({ notes: '', publishedAt: '' })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['no tag', { assets: [] }],
    ['an empty tag', { tag_name: '', assets: [] }],
    ['no assets list', { tag_name: '0.6.8' }],
  ])('throws INVALID_INPUT for %s', (_label, json) => {
    let thrown: unknown
    try {
      parseRelease(json)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('INVALID_INPUT')
  })
})

describe('GitHub requests', () => {
  let root: string
  let server: TestServer

  const latestPath = '/repos/ArchipelagoMW/Archipelago/releases/latest'
  const serveLatest = (): void =>
    server.handle((req, res) => {
      if (req.url !== latestPath) return reply(res, 404)
      if (req.headers['if-none-match'] === '"rel-1"') return reply(res, 304)
      reply(res, 200, JSON.stringify(fixture('release-0.6.8.json')), { etag: '"rel-1"' })
    })

  const makeHttp = (): ReturnType<typeof createHttp> =>
    createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: join(root, 'catalog'),
      log: silentLogger,
      githubToken: () => null,
      fetch: fetchVia(server, 'api.github.com'),
    })

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'goat releases é-'))
    server = await startTestServer((_req, res) => reply(res, 404))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  describe('fetchLatestApRelease', () => {
    it('asks /releases/latest of the Archipelago repository and parses the release', async () => {
      serveLatest()
      const release = await fetchLatestApRelease(makeHttp(), { force: false })
      expect(server.requests.map((r) => r.url)).toEqual([latestPath])
      expect(release.version).toBe('0.6.8')
      expect(release.windows?.sha256).toBe(WIN_SHA)
    })

    it('does not ask again within a few minutes, unless forced', async () => {
      serveLatest()
      const http = makeHttp()
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      const first = await fetchLatestApRelease(http, { force: false })

      clock.mockReturnValue(now + 60_000)
      expect(await fetchLatestApRelease(http)).toEqual(first)
      expect(await fetchLatestApRelease(http, { force: false })).toEqual(first)
      expect(server.requests).toHaveLength(1)

      expect(await fetchLatestApRelease(http, { force: true })).toEqual(first)
      expect(server.requests).toHaveLength(2)
      expect(server.requests[1]?.headers['if-none-match']).toBe('"rel-1"') // answered 304 from the cache

      clock.mockReturnValue(now + 60 * 60_000)
      await fetchLatestApRelease(http, { force: false })
      expect(server.requests).toHaveLength(3) // the first answer is no longer fresh
    })

    it('keeps the answers of two Http clients apart', async () => {
      serveLatest()
      await fetchLatestApRelease(makeHttp(), { force: false })
      await fetchLatestApRelease(makeHttp(), { force: false })
      expect(server.requests).toHaveLength(2)
    })

    it('answers from the cache when the network is down', async () => {
      serveLatest()
      await fetchLatestApRelease(makeHttp(), { force: false })
      server.handle(dropConnection)
      const release = await fetchLatestApRelease(makeHttp(), { force: true })
      expect(release.version).toBe('0.6.8')
    })

    it('does not keep an answer that came from the cache, so a back-online app asks again', async () => {
      serveLatest()
      await fetchLatestApRelease(makeHttp(), { force: false })
      const http = makeHttp()
      server.handle(dropConnection)
      await fetchLatestApRelease(http, { force: false }) // offline: from the disk cache
      serveLatest()
      await fetchLatestApRelease(http, { force: false })
      expect(server.requests.at(-1)?.headers['if-none-match']).toBe('"rel-1"')
      expect(server.requests).toHaveLength(3)
    })

    it('throws NETWORK_OFFLINE when it is offline and has nothing cached', async () => {
      server.handle(dropConnection)
      expect((await failure(fetchLatestApRelease(makeHttp(), { force: true }))).code).toBe('NETWORK_OFFLINE')
    })

    it('explains a rate limit', async () => {
      server.handle((_req, res) =>
        reply(res, 403, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
      )
      const error = await failure(fetchLatestApRelease(makeHttp(), { force: true }))
      expect(error.code).toBe('GITHUB_RATE_LIMITED')
      expect(error.params).toEqual({ resetAt: 1_790_000_000_000 })
    })

    it('maps an answer that is not a release to HTTP_ERROR', async () => {
      server.handle((_req, res) => reply(res, 200, JSON.stringify({ message: 'hello' })))
      const error = await failure(fetchLatestApRelease(makeHttp(), { force: true }))
      expect(error.code).toBe('HTTP_ERROR')
      expect(error.params).toEqual({ status: 200, url: `https://api.github.com${latestPath}` })
    })
  })

  describe('fetchReleaseByTag', () => {
    const bizhawk = {
      tag_name: '2.11.1',
      assets: [
        {
          name: BIZHAWK_ASSETS.win32,
          browser_download_url: `https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/${BIZHAWK_ASSETS.win32}`,
          size: 111,
          digest: `sha256:${'ab'.repeat(32)}`,
        },
        {
          name: BIZHAWK_ASSETS.linux,
          browser_download_url: `https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/${BIZHAWK_ASSETS.linux}`,
          size: 222,
          digest: null,
        },
        {
          name: 'notes.txt',
          browser_download_url: 'https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/notes.txt',
          size: 3,
        },
      ],
    }

    it('lists every asset of the release of that tag, with sha256 from the digest', async () => {
      server.handle((req, res) =>
        req.url === '/repos/TASEmulators/BizHawk/releases/tags/2.11.1'
          ? reply(res, 200, JSON.stringify(bizhawk))
          : reply(res, 404),
      )
      const { assets } = await fetchReleaseByTag(makeHttp(), 'TASEmulators/BizHawk', '2.11.1')
      expect(assets).toEqual([
        {
          name: BIZHAWK_ASSETS.win32,
          url: `https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/${BIZHAWK_ASSETS.win32}`,
          size: 111,
          sha256: 'ab'.repeat(32),
        },
        {
          name: BIZHAWK_ASSETS.linux,
          url: `https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/${BIZHAWK_ASSETS.linux}`,
          size: 222,
          sha256: null,
        },
        {
          name: 'notes.txt',
          url: 'https://github.com/TASEmulators/BizHawk/releases/download/2.11.1/notes.txt',
          size: 3,
          sha256: null,
        },
      ])
    })

    it('encodes the tag in the path', async () => {
      server.handle((_req, res) => reply(res, 200, JSON.stringify(bizhawk)))
      await fetchReleaseByTag(makeHttp(), 'o/r', 'tracker v1/2')
      expect(server.requests[0]?.url).toBe('/repos/o/r/releases/tags/tracker%20v1%2F2')
    })

    it('maps an unknown tag to HTTP_ERROR 404', async () => {
      server.handle((_req, res) => reply(res, 404, '{"message":"Not Found"}'))
      const error = await failure(fetchReleaseByTag(makeHttp(), 'o/r', 'nope'))
      expect(error.code).toBe('HTTP_ERROR')
      expect(error.params).toMatchObject({ status: 404 })
    })

    it('maps an answer without assets to HTTP_ERROR', async () => {
      server.handle((_req, res) => reply(res, 200, JSON.stringify({ tag_name: '1' })))
      expect((await failure(fetchReleaseByTag(makeHttp(), 'o/r', '1'))).code).toBe('HTTP_ERROR')
    })

    it.each(['', 'owner', 'a/b/c', '../x/y', 'o/r?x=1', 'o /r', '/r'])(
      'refuses the repository %j',
      async (repo) => {
        expect((await failure(fetchReleaseByTag(makeHttp(), repo, '1'))).code).toBe('INVALID_INPUT')
        expect(server.requests).toHaveLength(0)
      },
    )

    it('refuses an empty tag', async () => {
      expect((await failure(fetchReleaseByTag(makeHttp(), 'o/r', ''))).code).toBe('INVALID_INPUT')
    })
  })
})

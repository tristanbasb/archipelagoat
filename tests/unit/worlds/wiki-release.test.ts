import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttp } from '@main/core/system/http'
import { resolveWikiRelease } from '@main/core/worlds/wiki-release'
import { AppError } from '@shared/errors'
import { silentLogger } from '../../helpers/core'
import {
  dropConnection,
  fetchVia,
  githubFixture,
  reply,
  startTestServer,
  type TestServer,
} from '../../helpers/http-server'

// Real answers of /releases/latest, trimmed: one APWorld (Frogmonster), and two games in one
// repository (Burger Shop and Burger Shop 2).
type Release = { tag_name: string; assets: Record<string, unknown>[] }
const release = (name: string): Release => structuredClone(githubFixture(name)) as Release
const FROG = 'apworld-frogmonster.json'
const BURGER = 'apworld-burger-shop.json'

const FROG_PAGE = 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/latest'
const FROG_PATH = '/repos/rooby-roo/frogmonsterapworld/releases/latest'
const FROG_URL =
  'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/download/v0.2.5/frogmonster.apworld'
const FROG_SHA = '9fce6b13e43cdeda0246aef394f26d9299b9c86a3df1c8694357813c7b8a90c2'
const BURGER_PAGE = 'https://github.com/zsiegel701/Burger-Shop-Archipelago/releases/latest'
const BURGER_ASSETS = 'https://github.com/zsiegel701/Burger-Shop-Archipelago/releases/download/v0.3.2/'

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

let root: string
let server: TestServer

const makeHttp = (): ReturnType<typeof createHttp> =>
  createHttp({
    userAgent: 'Test/1.0 (unit)',
    cacheDir: join(root, 'catalog'),
    log: silentLogger,
    githubToken: () => null,
    fetch: fetchVia(server, 'api.github.com'),
  })

/** Serves `answer` as the latest release of every repository. */
const serve = (answer: unknown): void =>
  server.handle((_req, res) => reply(res, 200, JSON.stringify(answer), { etag: '"rel-1"' }))

const frogmonster = (http = makeHttp()): ReturnType<typeof resolveWikiRelease> =>
  resolveWikiRelease(http, 'rooby-roo/frogmonsterapworld', 'Frogmonster', FROG_PAGE)
const burgerShop = (game: string): ReturnType<typeof resolveWikiRelease> =>
  resolveWikiRelease(makeHttp(), 'zsiegel701/burger-shop-archipelago', game, BURGER_PAGE)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat wiki release é-'))
  server = await startTestServer((_req, res) => reply(res, 404))
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWikiRelease', () => {
  it('takes the only .apworld of the latest release, with its digest as sha256', async () => {
    serve(release(FROG))
    expect(await frogmonster()).toEqual({ version: '0.2.5', url: FROG_URL, sha256: FROG_SHA })
    expect(server.requests.map((r) => r.url)).toEqual([FROG_PATH])
    // Kept under its own key: the next ask is a conditional request, free of GitHub's quota.
    const cache = JSON.parse(readFileSync(join(root, 'catalog', 'http-cache.json'), 'utf8')) as {
      entries: Record<string, { url: string }>
    }
    expect(cache.entries['wiki-release:rooby-roo/frogmonsterapworld']?.url).toBe(
      `https://api.github.com${FROG_PATH}`,
    )
    await frogmonster()
    expect(server.requests[1]?.headers['if-none-match']).toBe('"rel-1"')
  })

  it('takes the only .apworld whatever its name, the title of a wiki page being no file name', async () => {
    serve(release(FROG))
    const http = makeHttp()
    const resolve = (game: string): ReturnType<typeof resolveWikiRelease> =>
      resolveWikiRelease(http, 'rooby-roo/frogmonsterapworld', game, FROG_PAGE)
    expect(await resolve('Frog Monster: Remastered')).toEqual({
      version: '0.2.5',
      url: FROG_URL,
      sha256: FROG_SHA,
    })
    const otherUrl = FROG_URL.replace('frogmonster.apworld', 'Other.APWORLD')
    const other = release(FROG)
    other.assets = other.assets.map((asset) =>
      asset.name === 'frogmonster.apworld'
        ? { ...asset, name: 'Other.APWORLD', browser_download_url: otherUrl }
        : asset,
    )
    serve(other)
    expect((await resolve('Frogmonster')).url).toBe(otherUrl)
  })

  it('picks, among several .apworld files, the one named after the game', async () => {
    serve(release(BURGER))
    expect(await burgerShop('Burger Shop 2')).toEqual({
      version: '0.3.2',
      url: `${BURGER_ASSETS}burger_shop_2.apworld`,
      sha256: 'd9b08ae512f33ed141afc00f5a90011824a0899a37020bace8d1c87793056023',
    })
    expect((await burgerShop('Burger Shop')).url).toBe(`${BURGER_ASSETS}burger_shop.apworld`)
    // Letters and digits only, accents and case set aside.
    expect((await burgerShop('BÜRGER  SHOP-2')).url).toBe(`${BURGER_ASSETS}burger_shop_2.apworld`)
  })

  it('refuses to guess when several .apworld files may be the game', async () => {
    serve(release(BURGER))
    expect(await failure(burgerShop('Burger Shop Deluxe'))).toMatchObject({
      code: 'WORLD_RELEASE_UNAVAILABLE',
      params: { reason: 'ambiguous', url: BURGER_PAGE },
    })
    const twins = release(BURGER)
    twins.assets.push({ ...twins.assets[2], name: 'Burger-Shop.APWORLD' })
    serve(twins)
    expect(await failure(burgerShop('Burger Shop'))).toMatchObject({ params: { reason: 'ambiguous' } })
  })

  it('says when the release has no .apworld, an asset served over plain http counting for none', async () => {
    const yamlOnly = release(FROG)
    yamlOnly.assets = yamlOnly.assets.filter((asset) => asset.name !== 'frogmonster.apworld')
    serve(yamlOnly)
    expect(await failure(frogmonster())).toMatchObject({
      code: 'WORLD_RELEASE_UNAVAILABLE',
      params: { reason: 'no-apworld', url: FROG_PAGE },
    })
    const plain = release(FROG)
    plain.assets = plain.assets.map((asset) => ({
      ...asset,
      browser_download_url: (asset.browser_download_url as string).replace('https:', 'http:'),
    }))
    serve(plain)
    expect(await failure(frogmonster())).toMatchObject({ params: { reason: 'no-apworld' } })
  })

  it('says when the repository has no stable release (GitHub answers 404)', async () => {
    server.handle((_req, res) => reply(res, 404, '{"message":"Not Found"}'))
    const error = await failure(frogmonster())
    expect(error.code).toBe('WORLD_RELEASE_UNAVAILABLE')
    expect(error.params).toEqual({ reason: 'no-release', url: FROG_PAGE })
  })

  it('gives sha256 null when GitHub has no digest for the asset, and keeps a tag without v', async () => {
    const old = release(FROG)
    old.tag_name = '2024.1'
    old.assets = old.assets.map((asset) => ({ ...asset, digest: null }))
    serve(old)
    expect(await frogmonster()).toEqual({ version: '2024.1', url: FROG_URL, sha256: null })
  })

  it.each(['', 'owner', 'a/b/c', '../x/y', 'o/..', 'o/r?x=1', 'o /r'])(
    'refuses the repository %j without asking GitHub',
    async (repo) => {
      const error = await failure(resolveWikiRelease(makeHttp(), repo, 'Game', FROG_PAGE))
      expect(error.code).toBe('INVALID_INPUT')
      expect(server.requests).toHaveLength(0)
    },
  )

  it('lets a rate limit, an error of the server and a failed network through', async () => {
    server.handle((_req, res) =>
      reply(res, 403, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
    )
    expect(await failure(frogmonster())).toMatchObject({
      code: 'GITHUB_RATE_LIMITED',
      params: { resetAt: 1_790_000_000_000 },
    })
    server.handle((_req, res) => reply(res, 500))
    expect(await failure(frogmonster())).toMatchObject({ code: 'HTTP_ERROR', params: { status: 500 } })
    server.handle(dropConnection)
    expect((await failure(frogmonster())).code).toBe('NETWORK_OFFLINE')
  })

  it('maps an answer that is not a release to HTTP_ERROR', async () => {
    serve({ message: 'hello' })
    expect(await failure(frogmonster())).toMatchObject({
      code: 'HTTP_ERROR',
      params: { status: 200, url: `https://api.github.com${FROG_PATH}` },
    })
  })
})

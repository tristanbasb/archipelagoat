import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coverKeyOf,
  createCovers,
  handleCoverRequest,
  imageTypeOf,
  type Covers,
  type CoversDeps,
} from '@main/core/covers/covers'
import type { Http } from '@main/core/context'
import { COVER_HOSTS, isCoverUrl } from '@shared/covers'
import { createTestContext, httpStub, type TestCore } from '../../helpers/core'

const MB = 1024 * 1024

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const GIF = [...Buffer.from('GIF89a')]
const WEBP = [...Buffer.from('RIFF'), 0x24, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]

/** An image of `size` bytes that starts with `signature`. */
const image = (signature: number[], size = 64): Buffer<ArrayBuffer> =>
  Buffer.concat([Buffer.from(signature), Buffer.alloc(Math.max(0, size - signature.length), 7)])
const png = (size = 64): Buffer<ArrayBuffer> => image(PNG, size)

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const WIKI = 'https://static.wikitide.net/archipelagowiki/thumb/d/da/Frogmonster.jpg/300px-Frogmonster.jpg'
const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Celeste_box_art_full.png?utm=original'

type Cover = { url: string; afterDark: boolean }
type Respond = (url: string, init: RequestInit) => Response | Promise<Response>

let root: string
let core: TestCore
let covers: Covers
let covered: Map<string, Cover>
let respond: Respond
let fetchRaw: ReturnType<typeof vi.fn<Http['fetchRaw']>>
let clock: number

const coversDir = (): string => join(core.ctx.platform.paths.dataRoot, 'covers')
const indexFile = (): string => join(coversDir(), 'index.json')
type Index = Record<string, { url: string; bytes: number; lastViewed: number }>
const readIndex = (): Index => JSON.parse(readFileSync(indexFile(), 'utf8')) as Index
const filesOfCache = (): string[] =>
  existsSync(coversDir()) ? readdirSync(coversDir()).filter((name) => name !== 'index.json') : []

const keyOfUrl = (url: string): string => `goat-cover://${sha256(url)}.png`
const keyName = (url: string): string => keyOfUrl(url).replace('goat-cover://', '')

function makeCovers(deps: Partial<CoversDeps> = {}): Covers {
  return createCovers(core.ctx, {
    lookupCover: (game) => covered.get(game) ?? null,
    now: () => ++clock,
    ...deps,
  })
}

/** Every game answers with a PNG of 64 bytes unless a test says otherwise. */
const okPng: Respond = () => new Response(png(), { headers: { 'content-type': 'image/png' } })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat covers é-'))
  core = createTestContext(root)
  covered = new Map([['Frogmonster', { url: WIKI, afterDark: false }]])
  respond = okPng
  clock = 1000
  fetchRaw = vi.fn<Http['fetchRaw']>((url, init) => Promise.resolve(respond(String(url), init ?? {})))
  core.ctx.http = { ...httpStub, fetchRaw }
  covers = makeCovers()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('imageTypeOf', () => {
  it('recognises PNG, JPEG, WebP and GIF signatures and nothing else', () => {
    expect(imageTypeOf(image(PNG))).toBe('png')
    expect(imageTypeOf(image(JPEG))).toBe('jpeg')
    expect(imageTypeOf(image(WEBP))).toBe('webp')
    expect(imageTypeOf(image(GIF))).toBe('gif')
    expect(imageTypeOf(image([...Buffer.from('GIF87a')]))).toBe('gif')

    expect(imageTypeOf(Buffer.from('<!doctype html><html></html>'))).toBeNull()
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    // RIFF but not WebP (a WAVE file), a truncated signature, nothing at all.
    expect(imageTypeOf(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull()
    expect(imageTypeOf(Buffer.from(PNG.slice(0, 7)))).toBeNull()
    expect(imageTypeOf(new Uint8Array(0))).toBeNull()
    expect(imageTypeOf(Buffer.from('GIF90a'))).toBeNull()
  })
})

describe('isCoverUrl', () => {
  it('accepts https on exactly the two cover hosts', () => {
    expect(COVER_HOSTS).toEqual(['static.wikitide.net', 'upload.wikimedia.org'])
    expect(isCoverUrl(WIKI)).toBe(true)
    expect(isCoverUrl(COMMONS)).toBe(true)
    expect(isCoverUrl('HTTPS://Static.Wikitide.NET/a.png')).toBe(true)
  })

  it('refuses every other scheme, host, port and credential', () => {
    for (const url of [
      'http://static.wikitide.net/a.png',
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0f/x.png/330px-x.png',
      'https://evil.example/x.png',
      'https://static.wikitide.net.evil.example/x.png',
      'https://evilstatic.wikitide.net/x.png',
      'https://sub.static.wikitide.net/x.png',
      'https://static.wikitide.net@evil.example/x.png',
      'https://user:secret@static.wikitide.net/x.png',
      'https://static.wikitide.net:8443/x.png',
      'https://static.wikitide.net./x.png',
      'ftp://static.wikitide.net/x.png',
      'data:image/png;base64,AAAA',
      '//static.wikitide.net/x.png',
      'static.wikitide.net/x.png',
      '',
    ]) {
      expect(isCoverUrl(url), url).toBe(false)
    }
  })
})

describe('urlFor', () => {
  it('downloads the cover once and answers a goat-cover:// link to a file of covers/', async () => {
    const url = await covers.urlFor('Frogmonster')
    expect(url).toBe(keyOfUrl(WIKI))
    expect(fetchRaw).toHaveBeenCalledTimes(1)
    expect(fetchRaw.mock.calls[0]?.[0]).toBe(WIKI)
    expect(filesOfCache()).toEqual([keyName(WIKI)])
    expect(readFileSync(join(coversDir(), keyName(WIKI)))).toEqual(png())
    // The index: the remote link, the size, the last view.
    expect(readIndex()).toEqual({
      [keyName(WIKI)]: { url: WIKI, bytes: 64, lastViewed: expect.any(Number) as number },
    })
  })

  it('names the file after the signature of the image, not the link or the content type', async () => {
    respond = () => new Response(image(JPEG), { headers: { 'content-type': 'image/png' } })
    expect(await covers.urlFor('Frogmonster')).toBe(`goat-cover://${sha256(WIKI)}.jpeg`)
    expect(await covers.serve(`${sha256(WIKI)}.jpeg`)).toEqual({ bytes: image(JPEG), mime: 'image/jpeg' })
  })

  it('downloads only https URLs on static.wikitide.net and upload.wikimedia.org', async () => {
    for (const url of [
      'http://static.wikitide.net/x.png',
      'https://evil.example/x.png',
      'https://static.wikitide.net.evil.example/x.png',
      'https://thumb.wikimedia.org/x/330px-x.png',
    ]) {
      covered.set('Hostile', { url, afterDark: false })
      expect(await covers.urlFor('Hostile'), url).toBeNull()
    }
    expect(fetchRaw).not.toHaveBeenCalled()
    expect(filesOfCache()).toEqual([])

    covered.set('Commons', { url: COMMONS, afterDark: false })
    expect(await covers.urlFor('Commons')).toBe(keyOfUrl(COMMONS))
  })

  it('answers null for a game with no cover', async () => {
    expect(await covers.urlFor('Unknown')).toBeNull()
    expect(fetchRaw).not.toHaveBeenCalled()
  })

  it('rejects a body over 2 MB or without an image signature', async () => {
    respond = () => new Response(png(2 * MB + 1), { headers: { 'content-type': 'image/png' } })
    expect(await covers.urlFor('Frogmonster')).toBeNull()

    respond = () =>
      new Response('<!doctype html><title>Not found</title>', { headers: { 'content-type': 'image/png' } })
    expect(await covers.urlFor('Frogmonster')).toBeNull()

    // Exactly 2 MB is fine.
    respond = () => new Response(png(2 * MB))
    expect(await covers.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    rmSync(coversDir(), { recursive: true })

    respond = () => new Response('Not found', { status: 404 })
    expect(await covers.urlFor('Frogmonster')).toBeNull()
    expect(filesOfCache()).toEqual([])
    expect(existsSync(indexFile())).toBe(false)
  })

  it('stops reading a body once it is past 2 MB, and trusts no declared size', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1
          controller.enqueue(new Uint8Array(MB).fill(1))
        },
      },
      { highWaterMark: 0 },
    )
    respond = () => new Response(endless, { headers: { 'content-type': 'image/png' } })
    expect(await covers.urlFor('Frogmonster')).toBeNull()
    // The third megabyte is the one that crosses the cap; the stream is cancelled there.
    expect(pulled).toBe(3)

    // A declared size over the cap is refused before the body is read.
    let touched = false
    const never = new ReadableStream<Uint8Array>(
      {
        pull() {
          touched = true
        },
      },
      { highWaterMark: 0 },
    )
    respond = () => new Response(never, { headers: { 'content-length': String(2 * MB + 1) } })
    expect(await covers.urlFor('Frogmonster')).toBeNull()
    expect(touched).toBe(false)
    expect(filesOfCache()).toEqual([])
  })

  it('answers null, without throwing, when the network fails', async () => {
    fetchRaw.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await covers.urlFor('Frogmonster')).toBeNull()
    // Asked again later, and the cache is still clean.
    expect(await covers.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
  })

  it('serves a cached cover without asking the network again', async () => {
    const first = await covers.urlFor('Frogmonster')
    const second = await covers.urlFor('Frogmonster')
    expect(second).toBe(first)
    expect(fetchRaw).toHaveBeenCalledTimes(1)

    // Nor does a later run (the cache is on disk).
    const later = makeCovers()
    expect(await later.urlFor('Frogmonster')).toBe(first)
    expect(fetchRaw).toHaveBeenCalledTimes(1)
  })

  it('downloads again a cover whose file has gone', async () => {
    await covers.urlFor('Frogmonster')
    rmSync(join(coversDir(), keyName(WIKI)))
    expect(await covers.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    expect(fetchRaw).toHaveBeenCalledTimes(2)
    expect(filesOfCache()).toEqual([keyName(WIKI)])
  })

  it('makes one request for the same cover asked many times at once', async () => {
    const answers = await Promise.all([1, 2, 3].map(() => covers.urlFor('Frogmonster')))
    expect(new Set(answers)).toEqual(new Set([keyOfUrl(WIKI)]))
    expect(fetchRaw).toHaveBeenCalledTimes(1)
  })

  it('does not serve an After Dark cover unless showAfterDark', async () => {
    covered.set('Hunie Pop', { url: COMMONS, afterDark: true })
    expect(core.ctx.config.get().showAfterDark).toBe(false)
    expect(await covers.urlFor('Hunie Pop')).toBeNull()
    expect(fetchRaw).not.toHaveBeenCalled()

    core.ctx.config.update({ showAfterDark: true })
    expect(await covers.urlFor('Hunie Pop')).toBe(keyOfUrl(COMMONS))
    // And it stops again as soon as the setting does, though the file is cached.
    core.ctx.config.update({ showAfterDark: false })
    expect(await covers.urlFor('Hunie Pop')).toBeNull()
  })

  it('never has more than 4 downloads at a time', async () => {
    const gates: (() => void)[] = []
    fetchRaw.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(new Response(png())))
        }),
    )
    for (let n = 0; n < 6; n++)
      covered.set(`G${n}`, { url: `https://static.wikitide.net/${n}.png`, afterDark: false })
    const answers = [0, 1, 2, 3, 4, 5].map((n) => covers.urlFor(`G${n}`))
    await vi.waitFor(() => expect(gates).toHaveLength(4))
    // Give the queue the time to start more than it should.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchRaw).toHaveBeenCalledTimes(4)

    gates[0]?.()
    await vi.waitFor(() => expect(gates).toHaveLength(5))
    gates.slice(1).forEach((open) => open())
    await vi.waitFor(() => expect(gates).toHaveLength(6))
    gates[5]?.()
    expect((await Promise.all(answers)).every((url) => url?.startsWith('goat-cover://'))).toBe(true)
  })

  it('gives up on a download after 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seen: { signal?: AbortSignal | null } = {}
    fetchRaw.mockImplementation((_url, init) => {
      seen.signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const answer = covers.urlFor('Frogmonster')
    while (fetchRaw.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(19_999)
    expect(seen.signal?.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(seen.signal?.aborted).toBe(true)
    expect(await answer).toBeNull()
  })

  it('follows a redirect only to a cover host, a few times', async () => {
    const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } })
    const final = 'https://upload.wikimedia.org/wikipedia/commons/final.png'

    respond = (url) => (url === WIKI ? redirect(final) : new Response(png()))
    expect(await covers.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    expect(fetchRaw.mock.calls.map(([url]) => String(url))).toEqual([WIKI, final])
    // Redirects are handled here, never by the platform.
    expect(fetchRaw.mock.calls[0]?.[1]?.redirect).toBe('manual')

    // A relative Location stays on the host.
    rmSync(coversDir(), { recursive: true })
    fetchRaw.mockClear()
    respond = (url) => (url === WIKI ? redirect('/archipelagowiki/other.png') : new Response(png()))
    expect(await covers.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    expect(fetchRaw.mock.calls.map(([url]) => String(url))).toEqual([
      WIKI,
      'https://static.wikitide.net/archipelagowiki/other.png',
    ])

    // Elsewhere, to http, without a Location, or in a loop: no cover.
    rmSync(coversDir(), { recursive: true })
    for (const location of ['https://evil.example/x.png', 'http://static.wikitide.net/x.png', '']) {
      fetchRaw.mockClear()
      respond = () => (location === '' ? new Response(null, { status: 302 }) : redirect(location))
      expect(await covers.urlFor('Frogmonster'), location).toBeNull()
      expect(fetchRaw).toHaveBeenCalledTimes(1)
    }
    fetchRaw.mockClear()
    respond = (url) => redirect(url)
    expect(await covers.urlFor('Frogmonster')).toBeNull()
    expect(fetchRaw.mock.calls.length).toBeLessThanOrEqual(4)
    expect(filesOfCache()).toEqual([])
  })
})

describe('the cache limit', () => {
  const GAMES = ['A', 'B', 'C']
  const urlOf = (game: string): string => `https://static.wikitide.net/${game}.png`

  beforeEach(() => {
    for (const game of GAMES) covered.set(game, { url: urlOf(game), afterDark: false })
    respond = () => new Response(png(400))
    covers = makeCovers({ maxCacheBytes: 1000 })
  })

  it('evicts the least recently viewed covers above the cache limit', async () => {
    for (const game of GAMES) await covers.urlFor(game)
    expect(filesOfCache().sort()).toEqual([keyName(urlOf('B')), keyName(urlOf('C'))].sort())
    expect(Object.keys(readIndex()).sort()).toEqual([keyName(urlOf('B')), keyName(urlOf('C'))].sort())
    expect(await covers.serve(keyName(urlOf('A')))).toBeNull()
    expect(await covers.serve(keyName(urlOf('B')))).not.toBeNull()
  })

  it('counts a cover seen again as viewed', async () => {
    await covers.urlFor('A')
    await covers.urlFor('B')
    await covers.urlFor('A')
    await covers.urlFor('C')
    expect(filesOfCache().sort()).toEqual([keyName(urlOf('A')), keyName(urlOf('C'))].sort())
  })

  it('keeps a cover that is alone over the limit', async () => {
    covers = makeCovers({ maxCacheBytes: 100 })
    respond = () => new Response(png(400))
    expect(await covers.urlFor('A')).toBe(keyOfUrl(urlOf('A')))
    expect(filesOfCache()).toEqual([keyName(urlOf('A'))])
    // The next one takes its place.
    expect(await covers.urlFor('B')).toBe(keyOfUrl(urlOf('B')))
    expect(filesOfCache()).toEqual([keyName(urlOf('B'))])
  })

  it('saves the date of a view that is long past, but not every view', async () => {
    await covers.urlFor('A')
    const key = keyName(urlOf('A'))
    const first = readIndex()[key]?.lastViewed
    // A moment later: nothing to write.
    await covers.urlFor('A')
    expect(readIndex()[key]?.lastViewed).toBe(first)
    // Two hours later: saved.
    clock += 2 * 60 * 60 * 1000
    await covers.urlFor('A')
    await vi.waitFor(() => expect(readIndex()[key]?.lastViewed).toBe(clock))
  })
})

describe('serve', () => {
  it('serves a cached file with the type of its signature', async () => {
    await covers.urlFor('Frogmonster')
    expect(await covers.serve(keyName(WIKI))).toEqual({ bytes: png(), mime: 'image/png' })
  })

  it('refuses keys that are not a cached file name', async () => {
    await covers.urlFor('Frogmonster')
    writeFileSync(join(core.ctx.platform.paths.dataRoot, 'secret.png'), png())
    // A file with a name of the right shape that the index does not list is not served either.
    const stray = `${sha256('stray')}.png`
    writeFileSync(join(coversDir(), stray), png())
    const key = keyName(WIKI)
    for (const name of [
      stray,
      '../catalog/catalog.json',
      'x/..',
      '..',
      '.',
      '',
      'index.json',
      `../${key}`,
      `./${key}`,
      `${key}/`,
      `${key}\\`,
      `..\\${key}`,
      key.toUpperCase(),
      key.replace('.png', '.PNG'),
      key.replace('.png', '.svg'),
      key.slice(0, 63) + '.png',
      `${'0'.repeat(64)}.png`,
      `${sha256('unknown')}.png`,
      `${key}\u0000`,
    ]) {
      expect(await covers.serve(name), JSON.stringify(name)).toBeNull()
    }
  })

  it('ignores an index that names a file outside covers/', async () => {
    writeFileSync(join(core.ctx.platform.paths.dataRoot, 'secret.png'), png())
    mkdirSync(coversDir(), { recursive: true })
    writeFileSync(
      indexFile(),
      JSON.stringify({
        '../secret.png': { url: WIKI, bytes: 64, lastViewed: 1 },
        [`${'a'.repeat(64)}.png`]: { url: WIKI, bytes: 64, lastViewed: 1 },
      }),
    )
    const fresh = makeCovers()
    expect(await fresh.serve('../secret.png')).toBeNull()
    // The honest entry of the same file is kept, but its file is missing: nothing to serve.
    expect(await fresh.serve(`${'a'.repeat(64)}.png`)).toBeNull()
  })

  it('never removes a file outside covers/, whatever the index says', async () => {
    const secret = join(core.ctx.platform.paths.dataRoot, 'secret.png')
    writeFileSync(secret, png())
    mkdirSync(coversDir(), { recursive: true })
    writeFileSync(
      indexFile(),
      JSON.stringify({ '../secret.png': { url: WIKI, bytes: 10_000, lastViewed: 1 } }),
    )
    // The oldest and the biggest: the first to go when the cache is over its limit.
    expect(await makeCovers({ maxCacheBytes: 100 }).urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    expect(existsSync(secret)).toBe(true)
    expect(Object.keys(readIndex())).toEqual([keyName(WIKI)])
  })

  it('starts empty from an index that does not parse', async () => {
    mkdirSync(coversDir(), { recursive: true })
    writeFileSync(indexFile(), '{ nope')
    const fresh = makeCovers()
    expect(await fresh.urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
    expect(readIndex()).toHaveProperty([keyName(WIKI)])

    writeFileSync(indexFile(), JSON.stringify({ [keyName(WIKI)]: { url: 3 } }))
    expect(await makeCovers().urlFor('Frogmonster')).toBe(keyOfUrl(WIKI))
  })

  it('forgets an entry whose file has gone', async () => {
    await covers.urlFor('Frogmonster')
    rmSync(join(coversDir(), keyName(WIKI)))
    expect(await covers.serve(keyName(WIKI))).toBeNull()
    await vi.waitFor(() => expect(readIndex()).toEqual({}))
  })
})

describe('the goat-cover:// protocol', () => {
  it('reads a key from goat-cover://<key> and from nothing else', () => {
    const key = keyName(WIKI)
    expect(coverKeyOf(`goat-cover://${key}`)).toBe(key)
    expect(coverKeyOf(`goat-cover://${key}/`)).toBe(key)
    for (const url of [
      `goat-cover://${key}/extra`,
      `goat-cover://${key}/..%2f..%2fsecret`,
      `goat-cover://${key}?x=1`,
      `goat-cover://${key}#x`,
      `goat-cover://user@${key}`,
      `goat-cover://${key}:80`,
      `goat-cover://../catalog/catalog.json`,
      `goat-cover:///${key}`,
      `goat-cover:${key}`,
      `https://${key}/`,
      `file:///${key}`,
      'goat-cover://',
      'not a url',
      '',
    ]) {
      expect(coverKeyOf(url), url).toBeNull()
    }
  })

  it('answers the file with its type, and 404 for anything else', async () => {
    await covers.urlFor('Frogmonster')
    const key = keyName(WIKI)
    const found = await handleCoverRequest(covers, `goat-cover://${key}`)
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('image/png')
    expect(found.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await found.arrayBuffer())).toEqual(png())

    for (const url of [
      `goat-cover://${sha256('unknown')}.png`,
      `goat-cover://${key}/../../catalog/catalog.json`,
      'goat-cover://../catalog/catalog.json',
      'goat-cover://index.json',
      'https://example.com/x.png',
      'nope',
    ]) {
      const refused = await handleCoverRequest(covers, url)
      expect(refused.status, url).toBe(404)
      expect(refused.headers.get('content-type')).toBeNull()
    }
  })
})

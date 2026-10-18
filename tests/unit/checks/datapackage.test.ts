import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCheckEstimates, parseDatapackage, type CheckEstimates } from '@main/core/checks/datapackage'
import type { Http } from '@main/core/context'
import { AppError } from '@shared/errors'
import { createTestContext, httpStub, type TestCore } from '../../helpers/core'

// The real answer of GET https://archipelago.gg/api/datapackage (fetched 2026-10-18), trimmed to three
// games (Hollow Knight, A Short Hike, A Link to the Past): each keeps its checksum and its whole
// location_name_to_id; the item maps and the groups are dropped.
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/checks/datapackage-excerpt.json', import.meta.url)),
  'utf8',
)

const DATAPACKAGE_URL = 'https://archipelago.gg/api/datapackage'
const HOLLOW_KNIGHT_CHECKSUM = '93fad68f24dcb8d9dd7f616ce5e376117fcedf32'
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY

type Respond = (init: RequestInit) => Response | Promise<Response>

let root: string
let core: TestCore
let clock: number
let respond: Respond
let fetchRaw: ReturnType<typeof vi.fn<Http['fetchRaw']>>

const tableFile = (): string => join(core.ctx.platform.paths.dataRoot, 'checks', 'datapackage.json')
const readTable = (): unknown => JSON.parse(readFileSync(tableFile(), 'utf8'))
const sent = (call: number): Headers => new Headers(fetchRaw.mock.calls[call]?.[1]?.headers)

const okFixture: Respond = () => new Response(FIXTURE, { headers: { etag: '"v1"' } })

function makeEstimates(): CheckEstimates {
  return createCheckEstimates(core.ctx, { now: () => clock })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat checks é-'))
  core = createTestContext(root)
  clock = 1_800_000_000_000
  respond = okFixture
  fetchRaw = vi.fn<Http['fetchRaw']>((_url, init) => Promise.resolve(respond(init ?? {})))
  core.ctx.http = { ...httpStub, fetchRaw }
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('parseDatapackage', () => {
  it('counts the locations of each game', () => {
    const table = parseDatapackage(JSON.parse(FIXTURE))
    expect(table).toEqual({
      'Hollow Knight': { max: 740, checksum: HOLLOW_KNIGHT_CHECKSUM },
      'A Short Hike': { max: 131, checksum: expect.any(String) as string },
      'A Link to the Past': { max: 286, checksum: expect.any(String) as string },
    })
  })

  it('keeps no item map, no group and no location name', () => {
    const table = parseDatapackage({
      games: {
        Tiny: {
          checksum: 'abc',
          item_name_groups: { Everything: ['x'] },
          item_name_to_id: { x: 1 },
          location_name_groups: {},
          location_name_to_id: { a: 10, b: 11 },
        },
      },
    })
    expect(table).toEqual({ Tiny: { max: 2, checksum: 'abc' } })
  })

  it('takes a missing or empty checksum for unknown', () => {
    const table = parseDatapackage({
      games: { A: { location_name_to_id: { a: 1 } }, B: { checksum: null, location_name_to_id: { b: 2 } } },
    })
    expect(table).toEqual({ A: { max: 1, checksum: null }, B: { max: 1, checksum: null } })
  })

  it('leaves out a game with no location: there is nothing to estimate', () => {
    expect(parseDatapackage({ games: { Empty: { checksum: 'x', location_name_to_id: {} } } })).toEqual({})
  })

  it('throws HTTP_ERROR for a shape that is not a datapackage', () => {
    for (const wrong of [
      null,
      [],
      'games',
      {},
      { games: [] },
      { games: { A: null } },
      { games: { A: { checksum: 'x' } } },
      { games: { A: { checksum: 'x', location_name_to_id: [] } } },
      { games: { A: { checksum: 'x', location_name_to_id: { a: 'one' } } } },
      { games: { A: { checksum: 7, location_name_to_id: { a: 1 } } } },
    ]) {
      let error: unknown
      try {
        parseDatapackage(wrong)
      } catch (caught) {
        error = caught
      }
      expect(error, JSON.stringify(wrong)).toBeInstanceOf(AppError)
      expect((error as AppError).code, JSON.stringify(wrong)).toBe('HTTP_ERROR')
      expect((error as AppError).params).toEqual({ status: 200, url: DATAPACKAGE_URL })
    }
  })

  it('lets a game named __proto__ pollute nothing', () => {
    const table = parseDatapackage(
      JSON.parse(
        '{"games":{"__proto__":{"checksum":"x","location_name_to_id":{"a":1}},"Real":{"location_name_to_id":{"b":2}}}}',
      ),
    )
    expect(Object.keys(table)).toEqual(['Real'])
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype)
    expect(({} as { max?: number }).max).toBeUndefined()
  })
})

describe('maxFor and refresh', () => {
  it('knows nothing before the first refresh, and then the locations of each game', async () => {
    const estimates = makeEstimates()
    expect(estimates.maxFor('Hollow Knight')).toBeNull()

    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(1)
    expect(fetchRaw.mock.calls[0]?.[0]).toBe(DATAPACKAGE_URL)
    expect(sent(0).get('accept')).toBe('application/json')
    expect(sent(0).has('if-none-match')).toBe(false)
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
    expect(estimates.maxFor('A Short Hike')).toBe(131)
    expect(estimates.maxFor('A Link to the Past')).toBe(286)
    expect(estimates.maxFor('Unknown Game')).toBeNull()
  })

  it('finds a game whose name differs only in accents, case or punctuation', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()
    expect(estimates.maxFor('hollow knight')).toBe(740)
    expect(estimates.maxFor('Hollów  Knight')).toBe(740)
    expect(estimates.maxFor('A Link to the Past!')).toBe(286)
    expect(estimates.maxFor('A-Short-Hike')).toBe(131)
    expect(estimates.maxFor('')).toBeNull()
  })

  it('writes the table to dataRoot/checks/datapackage.json, without the location names', async () => {
    await makeEstimates().refresh()
    expect(readTable()).toEqual({
      fetchedAt: clock,
      etag: '"v1"',
      games: {
        'Hollow Knight': { max: 740, checksum: HOLLOW_KNIGHT_CHECKSUM },
        'A Short Hike': { max: 131, checksum: expect.any(String) as string },
        'A Link to the Past': { max: 286, checksum: expect.any(String) as string },
      },
    })
    expect(readFileSync(tableFile(), 'utf8').length).toBeLessThan(2000)
  })

  it('answers from the file on the next run, with no request', async () => {
    await makeEstimates().refresh()
    fetchRaw.mockClear()

    const later = makeEstimates()
    expect(later.maxFor('Hollow Knight')).toBe(740)
    await later.refresh()
    expect(fetchRaw).not.toHaveBeenCalled()
  })

  it('refreshes at most once a week', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(1)

    clock += 3 * DAY
    await estimates.refresh()
    clock += WEEK - 3 * DAY - 1
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(1)

    // Seven days after the last answer: one request, which sends the ETag it was given.
    clock += 1
    respond = () => new Response(null, { status: 304 })
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(2)
    expect(sent(1).get('if-none-match')).toBe('"v1"')
    expect(estimates.maxFor('Hollow Knight')).toBe(740)

    // A 304 is an answer too: the week starts again from it.
    clock += 6 * DAY
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(2)
  })

  it('counts a clock set back as an old answer', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()
    clock -= DAY
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(2)
  })

  it('refreshes when forced, even within the week', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()
    await estimates.refresh(true)
    expect(fetchRaw).toHaveBeenCalledTimes(2)
    expect(sent(1).get('if-none-match')).toBe('"v1"')
  })

  it('sends the ETag the server last gave, and takes the entries of a changed answer', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()

    clock += WEEK
    respond = () =>
      new Response(
        JSON.stringify({
          games: { 'Hollow Knight': { checksum: 'new', location_name_to_id: { a: 1, b: 2, c: 3 } } },
        }),
        { headers: { etag: '"v2"' } },
      )
    await estimates.refresh()
    expect(estimates.maxFor('Hollow Knight')).toBe(3)
    expect(readTable()).toMatchObject({ fetchedAt: clock, etag: '"v2"' })

    clock += WEEK
    await estimates.refresh()
    expect(sent(2).get('if-none-match')).toBe('"v2"')
  })

  it('makes one request for refreshes asked while one is running', async () => {
    let release: () => void = () => undefined
    respond = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(okFixture({}))
      })
    const estimates = makeEstimates()
    const first = estimates.refresh()
    const second = estimates.refresh(true)
    await vi.waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(fetchRaw).toHaveBeenCalledTimes(1)
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
  })

  it('tells the renderer when the table changed, and only then', async () => {
    const changed = vi.fn()
    core.ctx.bus.on('checks:changed', changed)
    const estimates = makeEstimates()

    await estimates.refresh()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith(null)

    // The same table again, and a 304: nothing to tell.
    await estimates.refresh(true)
    respond = () => new Response(null, { status: 304 })
    await estimates.refresh(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('size limit', () => {
  /** A body that never ends: 1 MB of spaces per pull. `pulled()` counts the megabytes asked of it. */
  function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(MB).fill(0x20)
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    return { body, pulled: () => pulled, cancelled: () => cancelled }
  }

  it('refuses a datapackage over 32 MB, and stops reading it there', async () => {
    const stream = endless()
    respond = () => new Response(stream.body, { headers: { etag: '"big"' } })
    const estimates = makeEstimates()
    await estimates.refresh()

    // The 33rd megabyte is the one that crosses the cap; the stream is cancelled there.
    expect(stream.pulled()).toBe(33)
    expect(stream.cancelled()).toBe(true)
    expect(estimates.maxFor('Hollow Knight')).toBeNull()
    expect(() => readFileSync(tableFile())).toThrow()
  })

  it('refuses a declared size over 32 MB before reading anything', async () => {
    const stream = endless()
    respond = () => new Response(stream.body, { headers: { 'content-length': String(32 * MB + 1) } })
    await makeEstimates().refresh()
    expect(stream.pulled()).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  it('takes a datapackage of exactly 32 MB', async () => {
    const padding = ' '.repeat(32 * MB - Buffer.byteLength(FIXTURE))
    respond = () => new Response(FIXTURE + padding)
    const estimates = makeEstimates()
    await estimates.refresh()
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
  })
})

describe('when the refresh fails', () => {
  it.each([
    ['the network is down', () => Promise.reject(new AppError('NETWORK_OFFLINE'))],
    ['the server answers 500', () => new Response('oops', { status: 500 })],
    ['the answer is not JSON', () => new Response('<html>captive portal</html>')],
    ['the answer is not a datapackage', () => new Response('{"games":[]}')],
  ] as [string, Respond][])('keeps the previous table when %s', async (_name, failure) => {
    const estimates = makeEstimates()
    await estimates.refresh()
    const before = readFileSync(tableFile(), 'utf8')

    clock += WEEK
    respond = failure
    await expect(estimates.refresh()).resolves.toBeUndefined()
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
    expect(readFileSync(tableFile(), 'utf8')).toBe(before)

    // The week did not start again: it is asked once more next time.
    respond = okFixture
    await estimates.refresh()
    expect(fetchRaw).toHaveBeenCalledTimes(3)
  })

  it('gives up after 2 minutes, the body included', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seen: { signal?: AbortSignal | null } = {}
    fetchRaw.mockImplementation((_url, init) => {
      seen.signal = init?.signal
      // The headers arrive, then the body stalls until the deadline.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          )
        },
      })
      return Promise.resolve(new Response(body))
    })
    const estimates = makeEstimates()
    const done = estimates.refresh()
    while (fetchRaw.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(119_999)
    expect(seen.signal?.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(seen.signal?.aborted).toBe(true)
    await done
    expect(estimates.maxFor('Hollow Knight')).toBeNull()
  })

  it('answers nothing, without throwing, when there never was a table', async () => {
    respond = () => Promise.reject(new TypeError('fetch failed'))
    const estimates = makeEstimates()
    await expect(estimates.refresh()).resolves.toBeUndefined()
    expect(estimates.maxFor('Hollow Knight')).toBeNull()
  })

  it('keeps the table in memory when the file cannot be written', async () => {
    // A file where the folder should be: nothing can be written under it.
    writeFileSync(join(core.ctx.platform.paths.dataRoot, 'checks'), 'in the way')
    const warn = vi.spyOn(core.ctx.log, 'warn')
    const estimates = makeEstimates()
    await expect(estimates.refresh()).resolves.toBeUndefined()
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
    expect(warn).toHaveBeenCalledWith('checks: cannot save the datapackage table', expect.anything())
  })

  it('starts from nothing when the file on disk is not a table', async () => {
    mkdirSync(dirname(tableFile()), { recursive: true })
    for (const content of ['{not json', '[]', '{"fetchedAt":"yesterday","etag":null,"games":{}}']) {
      writeFileSync(tableFile(), content)
      const estimates = makeEstimates()
      expect(estimates.maxFor('Hollow Knight'), content).toBeNull()
      await estimates.refresh()
      expect(estimates.maxFor('Hollow Knight'), content).toBe(740)
    }
  })
})

describe('addFromMultidata', () => {
  it('adds a custom game, which stays through the next refresh', async () => {
    const estimates = makeEstimates()
    await estimates.refresh()
    expect(estimates.maxFor('My Custom Game')).toBeNull()

    await estimates.addFromMultidata({ 'My Custom Game': { max: 42, checksum: 'c1' } })
    expect(estimates.maxFor('My Custom Game')).toBe(42)
    expect(readTable()).toMatchObject({ games: { 'My Custom Game': { max: 42, checksum: 'c1' } } })

    clock += WEEK
    await estimates.refresh()
    expect(estimates.maxFor('My Custom Game')).toBe(42)
    expect(estimates.maxFor('Hollow Knight')).toBe(740)
  })

  it('ignores a game with no location', async () => {
    const estimates = makeEstimates()
    await estimates.addFromMultidata({
      Empty: { max: 0, checksum: 'e' },
      Odd: { max: Number.NaN, checksum: null },
    })
    expect(estimates.maxFor('Empty')).toBeNull()
    expect(estimates.maxFor('Odd')).toBeNull()
  })

  it('works before any refresh, and a later run reads it back', async () => {
    await makeEstimates().addFromMultidata({ 'My Custom Game': { max: 42, checksum: 'c1' } })
    expect(makeEstimates().maxFor('My Custom Game')).toBe(42)
  })

  it('keeps the larger entry for the same checksum', async () => {
    const estimates = makeEstimates()
    await estimates.addFromMultidata({ Game: { max: 10, checksum: 'same' } })
    await estimates.addFromMultidata({ Game: { max: 7, checksum: 'same' } })
    expect(estimates.maxFor('Game')).toBe(10)
    await estimates.addFromMultidata({ Game: { max: 12, checksum: 'same' } })
    expect(estimates.maxFor('Game')).toBe(12)
  })

  it('takes the entry of another checksum, which is another version of the game', async () => {
    const estimates = makeEstimates()
    await estimates.addFromMultidata({ Game: { max: 10, checksum: 'old' } })
    await estimates.addFromMultidata({ Game: { max: 7, checksum: 'new' } })
    expect(estimates.maxFor('Game')).toBe(7)
    // A checksum nobody knows proves nothing: the latest answer wins.
    await estimates.addFromMultidata({ Game: { max: 9, checksum: null } })
    expect(estimates.maxFor('Game')).toBe(9)
  })

  it('tells the renderer only when something changed', async () => {
    const changed = vi.fn()
    core.ctx.bus.on('checks:changed', changed)
    const estimates = makeEstimates()

    await estimates.addFromMultidata({ Game: { max: 10, checksum: 'a' } })
    expect(changed).toHaveBeenCalledTimes(1)
    await estimates.addFromMultidata({ Game: { max: 10, checksum: 'a' } })
    await estimates.addFromMultidata({ Game: { max: 3, checksum: 'a' } })
    await estimates.addFromMultidata({})
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('does not lose a game added while the file is being written', async () => {
    const estimates = makeEstimates()
    await Promise.all([
      estimates.addFromMultidata({ One: { max: 1, checksum: 'a' } }),
      estimates.addFromMultidata({ Two: { max: 2, checksum: 'b' } }),
      estimates.addFromMultidata({ Three: { max: 3, checksum: 'c' } }),
    ])
    const later = makeEstimates()
    expect([later.maxFor('One'), later.maxFor('Two'), later.maxFor('Three')]).toEqual([1, 2, 3])
  })
})

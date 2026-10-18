import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { MAX_INFLATED_BYTES, readMultidata, readMultidataFromZip } from '@main/core/checks/multidata'
import { type PickleValue } from '@main/core/checks/pickle'
import { AppError } from '@shared/errors'
import { makePatchZip, makeSeedZip } from '../../helpers/make-patch.mjs'
import { pickle, pickleMultidata } from '../../helpers/make-pickle.mjs'

// A real multidata: Archipelago 0.6.8 (ArchipelagoGenerate, seed 42) made it from the template YAMLs
// of Hollow Knight (player Knight) and A Short Hike (player Claire).
const REAL = readFileSync(
  fileURLToPath(new URL('../../fixtures/multidata/hk-ash-0.6.8.archipelago', import.meta.url)),
)

const SHA1 = /^[0-9a-f]{40}$/

/** The error `fn` throws; fails when it does not throw an AppError. */
function failure(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

const unreadable = (fn: () => unknown): unknown => {
  const error = failure(fn)
  expect(error.code).toBe('MULTIDATA_UNREADABLE')
  return error.params?.reason
}

/** A multidata file around `pickled`: the format byte 3, then its zlib. */
const multidataOf = (pickled: Uint8Array): Buffer => Buffer.concat([Buffer.from([3]), deflateSync(pickled)])

const dict = (entries: [PickleValue, PickleValue][]): Map<PickleValue, PickleValue> => new Map(entries)

describe('readMultidata', () => {
  it('reads the real AP 0.6.8 multidata', () => {
    const summary = readMultidata(REAL)
    expect(summary.version).toBe(3)
    expect(summary.slots).toEqual([
      { slot: 1, name: 'Claire', game: 'A Short Hike', checks: 131 },
      { slot: 2, name: 'Knight', game: 'Hollow Knight', checks: 203 },
    ])
    // The datapackage of a game lists all its locations, not only the ones this slot has.
    expect(summary.datapackage['Hollow Knight']?.max).toBe(740)
    expect(summary.datapackage).toEqual({
      'A Short Hike': { max: 131, checksum: '233dd3b4c773aeea9ffd994b87f2773fe652877c' },
      'Hollow Knight': { max: 740, checksum: '93fad68f24dcb8d9dd7f616ce5e376117fcedf32' },
      Archipelago: { max: 2, checksum: 'ac9141e9ad0318df2fa27da5f20c50a842afeecb' },
    })
  })

  it('round-trips the test helper’s multidata', () => {
    const slots = [
      { name: 'Alice', game: 'Pokemon Emerald', checks: 300 },
      { name: 'Bob', game: 'A Hat in Time', checks: 40 },
      { name: 'Carol', game: 'Pokemon Emerald', checks: 250 },
    ]
    const summary = readMultidata(pickleMultidata({ slots }))
    expect(summary).toEqual({
      version: 3,
      slots: slots.map((slot, i) => ({ slot: i + 1, ...slot })),
      datapackage: {
        'Pokemon Emerald': { max: 300, checksum: expect.stringMatching(SHA1) as string },
        'A Hat in Time': { max: 40, checksum: expect.stringMatching(SHA1) as string },
        Archipelago: { max: 2, checksum: expect.stringMatching(SHA1) as string },
      },
    })
  })

  it('lists a slot that has no check, and a name with accents', () => {
    const summary = readMultidata(
      pickleMultidata({ slots: [{ name: 'Zoé ✨', game: 'Timespinner', checks: 0 }] }),
    )
    expect(summary.slots).toEqual([{ slot: 1, name: 'Zoé ✨', game: 'Timespinner', checks: 0 }])
  })

  it('orders the slots by number, whatever the order of the file', () => {
    const slotInfo = (name: string, game: string): PickleValue => ({
      object: {
        class: { global: { module: 'NetUtils', name: 'NetworkSlot' } },
        args: { tuple: [name, game, 1, { tuple: [] }] },
        state: null,
      },
    })
    const bytes = multidataOf(
      pickle(
        dict([
          [
            'locations',
            dict([
              [3, dict([[1, { tuple: [1, 3, 0] }]])],
              [1, dict([])],
              [2, dict([])],
            ]),
          ],
          [
            'slot_info',
            dict([
              [2, slotInfo('B', 'Game B')],
              [3, slotInfo('C', 'Game C')],
              [1, slotInfo('A', 'Game A')],
            ]),
          ],
        ]),
      ),
    )
    expect(readMultidata(bytes).slots).toEqual([
      { slot: 1, name: 'A', game: 'Game A', checks: 0 },
      { slot: 2, name: 'B', game: 'Game B', checks: 0 },
      { slot: 3, name: 'C', game: 'Game C', checks: 1 },
    ])
  })

  describe('names and games', () => {
    const locations = dict([
      [1, dict([[10, { tuple: [1, 1, 0] }]])],
      [2, dict([])],
    ])
    const slotInfo = (args: PickleValue): PickleValue => ({
      object: { class: { global: { module: 'NetUtils', name: 'NetworkSlot' } }, args, state: null },
    })
    const connectNames = dict([
      ['Amy', { tuple: [0, 1] }],
      ['Ben', { tuple: [0, 2] }],
    ])

    it('falls back to connect_names for the name when there is no slot_info', () => {
      const bytes = multidataOf(
        pickle(
          dict([
            ['locations', locations],
            ['connect_names', connectNames],
          ]),
        ),
      )
      expect(readMultidata(bytes).slots).toEqual([
        { slot: 1, name: 'Amy', game: '', checks: 1 },
        { slot: 2, name: 'Ben', game: '', checks: 0 },
      ])
    })

    it('falls back for the slots whose slot_info is missing or is not a NetworkSlot', () => {
      const bytes = multidataOf(
        pickle(
          dict([
            ['locations', locations],
            ['connect_names', connectNames],
            ['slot_info', dict([[1, slotInfo({ tuple: ['Alice', 'Game A', 1, { tuple: [] }] })]])],
          ]),
        ),
      )
      expect(readMultidata(bytes).slots).toEqual([
        { slot: 1, name: 'Alice', game: 'Game A', checks: 1 },
        { slot: 2, name: 'Ben', game: '', checks: 0 },
      ])
      for (const args of [null, { tuple: [] }, { tuple: ['Only a name'] }, { tuple: [1, 2] }, ['a', 'b']]) {
        const odd = multidataOf(
          pickle(
            dict([
              ['locations', locations],
              ['connect_names', connectNames],
              ['slot_info', dict([[1, slotInfo(args)]])],
            ]),
          ),
        )
        expect(readMultidata(odd).slots[0], JSON.stringify(args)).toEqual({
          slot: 1,
          name: 'Amy',
          game: '',
          checks: 1,
        })
      }
    })

    it('has an empty name when no table knows the slot', () => {
      const bytes = multidataOf(pickle(dict([['locations', locations]])))
      expect(readMultidata(bytes).slots.map((slot) => slot.name)).toEqual(['', ''])
    })
  })

  describe('datapackage', () => {
    const slots = dict([[1, dict([])]])
    const table = (names: string[], checksum: PickleValue): PickleValue =>
      dict([
        ['location_name_to_id', dict(names.map((name, i): [PickleValue, PickleValue] => [name, i]))],
        ['checksum', checksum],
      ])

    it('counts the keys of location_name_to_id, and keeps the checksum', () => {
      const bytes = multidataOf(
        pickle(
          dict([
            ['locations', slots],
            ['datapackage', dict([['G', table(['a', 'b', 'c'], 'abc')]])],
          ]),
        ),
      )
      expect(readMultidata(bytes).datapackage).toEqual({ G: { max: 3, checksum: 'abc' } })
    })

    it('leaves a missing checksum null, and a game with no table out', () => {
      const bytes = multidataOf(
        pickle(
          dict([
            ['locations', slots],
            [
              'datapackage',
              dict([
                ['NoChecksum', dict([['location_name_to_id', dict([['a', 1]])]])],
                ['NoneChecksum', table(['a'], null)],
                ['NoTable', dict([['checksum', 'x']])],
                ['TableNotADict', dict([['location_name_to_id', [1, 2]]])],
                ['NotADict', 'text'],
                [42, table(['a'], 'x')],
              ]),
            ],
          ]),
        ),
      )
      expect(readMultidata(bytes).datapackage).toEqual({
        NoChecksum: { max: 1, checksum: null },
        NoneChecksum: { max: 1, checksum: null },
      })
    })

    it('is empty when the file has none', () => {
      expect(readMultidata(multidataOf(pickle(dict([['locations', slots]])))).datapackage).toEqual({})
    })

    it('makes no game name reach the prototype', () => {
      const bytes = multidataOf(
        pickle(
          dict([
            ['locations', slots],
            ['datapackage', dict([['__proto__', table(['a'], 'x')]])],
          ]),
        ),
      )
      const { datapackage } = readMultidata(bytes)
      expect(Object.getPrototypeOf(datapackage)).toBe(Object.prototype)
      expect(Object.keys(datapackage)).toEqual(['__proto__'])
      expect(({} as { max?: number }).max).toBeUndefined()
    })
  })

  describe('refuses', () => {
    it('an unknown format byte', () => {
      for (const version of [0, 1, 2, 4, 255]) {
        expect(
          unreadable(() => readMultidata(Buffer.concat([Buffer.from([version]), REAL.subarray(1)]))),
        ).toBe('version')
      }
    })

    it('an empty file', () => {
      expect(unreadable(() => readMultidata(new Uint8Array()))).toBe('truncated')
    })

    it('a zlib bomb: a file that inflates past the limit', () => {
      const bomb = Buffer.concat([Buffer.from([3]), deflateSync(Buffer.alloc(2_000_000))])
      expect(bomb.length).toBeLessThan(5000)
      expect(unreadable(() => readMultidata(bomb, { maxInflatedBytes: 1_000_000 }))).toBe('size')
      // Under the limit it gets as far as the pickle, which it is not.
      expect(unreadable(() => readMultidata(bomb, { maxInflatedBytes: 4_000_000 }))).toBe('opcode')
    })

    it('a zlib bomb past the 256 MiB limit', () => {
      expect(MAX_INFLATED_BYTES).toBe(256 * 1024 * 1024)
      const bomb = Buffer.concat([
        Buffer.from([3]),
        deflateSync(Buffer.alloc(MAX_INFLATED_BYTES + 1), { level: 1 }),
      ])
      expect(unreadable(() => readMultidata(bomb))).toBe('size')
    })

    it('a truncated file, whether the cut is in the zlib stream or in the pickle', () => {
      expect(unreadable(() => readMultidata(REAL.subarray(0, 2000)))).toBe('truncated')
      expect(unreadable(() => readMultidata(Buffer.from([3, 1, 2, 3, 4, 5])))).toBe('truncated')
      const pickled = inflateSync(REAL.subarray(1))
      expect(unreadable(() => readMultidata(multidataOf(pickled.subarray(0, 1000))))).toBe('truncated')
      expect(unreadable(() => readMultidata(multidataOf(pickled.subarray(0, pickled.length - 1))))).toBe(
        'truncated',
      )
    })

    it('opcodes outside the list: INST, OBJ, PERSID and EXT1', () => {
      for (const opcode of ['i', 'o', 'P', '\x82']) {
        const pickled = Buffer.concat([
          Buffer.from([0x80, 4]),
          Buffer.from(opcode, 'latin1'),
          Buffer.from('os\nsystem\n.'),
        ])
        expect(
          unreadable(() => readMultidata(multidataOf(pickled))),
          JSON.stringify(opcode),
        ).toBe('opcode')
      }
    })

    it('a nesting deeper than 64', () => {
      let deep: PickleValue = []
      for (let i = 0; i < 70; i++) deep = [deep]
      expect(unreadable(() => readMultidata(multidataOf(pickle(deep))))).toBe('depth')
    })

    it('a pickle without locations, or that is no dict of dicts', () => {
      const shapes: PickleValue[] = [
        dict([]),
        dict([['slot_info', dict([])]]),
        [],
        'text',
        null,
        dict([['locations', [1, 2]]]),
        dict([['locations', dict([[1, [1, 2]]])]]),
        dict([['locations', dict([['one', dict([])]])]]),
        dict([['locations', dict([[1.5, dict([])]])]]),
        dict([['locations', dict([[0, dict([])]])]]),
        dict([['locations', dict([[2n ** 70n, dict([])]])]]),
        dict([
          ['locations', dict([[1, dict([])]])],
          ['datapackage', 'text'],
        ]),
      ]
      for (const [i, shape] of shapes.entries()) {
        expect(
          unreadable(() => readMultidata(multidataOf(pickle(shape)))),
          `shape ${i}`,
        ).toBe('shape')
      }
    })
  })
})

describe('readMultidataFromZip', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat multidata é-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

  it('reads the .archipelago of a generation', async () => {
    const zip = await makeSeedZip(join(root, 'AP_77.zip'), {
      seed: '77',
      slots: [
        { name: 'Alice', game: 'Pokemon Emerald', patch: '.apemerald', checks: 250 },
        { name: 'Bob', game: 'A Hat in Time' },
      ],
    })
    const summary = await readMultidataFromZip(zip)
    expect(summary.version).toBe(3)
    expect(summary.slots).toEqual([
      { slot: 1, name: 'Alice', game: 'Pokemon Emerald', checks: 250 },
      { slot: 2, name: 'Bob', game: 'A Hat in Time', checks: 100 },
    ])
    expect(summary.datapackage['Pokemon Emerald']?.max).toBe(250)
  })

  it('reads the real multidata from a zip', async () => {
    const zip = await makePatchZip(join(root, 'AP_02053695854357871005.zip'), null, {
      'AP_02053695854357871005.archipelago': REAL,
      'AP_02053695854357871005_Spoiler.txt': 'spoiler',
    })
    expect((await readMultidataFromZip(zip)).slots.map((slot) => slot.checks)).toEqual([131, 203])
  })

  it('says so when the zip holds no .archipelago', async () => {
    const zip = await makePatchZip(join(root, 'none.zip'), null, { 'AP_1_Spoiler.txt': 'spoiler' })
    expect((await failureOf(readMultidataFromZip(zip))).code).toBe('AP_NO_ARCHIPELAGO_IN_ZIP')
  })

  it('refuses a zip that holds several, and ignores one inside a folder', async () => {
    const two = await makePatchZip(join(root, 'two.zip'), null, {
      'AP_1.archipelago': REAL,
      'AP_2.archipelago': REAL,
    })
    const error = await failureOf(readMultidataFromZip(two))
    expect([error.code, error.params]).toEqual(['MULTIDATA_UNREADABLE', { reason: 'shape' }])
    const nested = await makePatchZip(join(root, 'nested.zip'), null, { 'sub/AP_1.archipelago': REAL })
    expect((await failureOf(readMultidataFromZip(nested))).code).toBe('AP_NO_ARCHIPELAGO_IN_ZIP')
  })

  it('refuses a file that is no zip, and a multidata that is no multidata', async () => {
    const notZip = join(root, 'not.zip')
    writeFileSync(notZip, 'this is not a zip')
    const error = await failureOf(readMultidataFromZip(notZip))
    expect([error.code, error.params]).toEqual(['MULTIDATA_UNREADABLE', { reason: 'truncated' }])

    const garbage = await makePatchZip(join(root, 'garbage.zip'), null, {
      'AP_1.archipelago': Buffer.from([4, 1, 2]),
    })
    expect((await failureOf(readMultidataFromZip(garbage))).params).toEqual({ reason: 'version' })
  })

  it('refuses an entry over the limit before it reads it', async () => {
    const zip = await makeSeedZip(join(root, 'AP_1.zip'), {
      seed: '1',
      slots: [{ name: 'Alice', game: 'G' }],
    })
    const error = await failureOf(readMultidataFromZip(zip, { maxInflatedBytes: 100 }))
    expect([error.code, error.params]).toEqual(['MULTIDATA_UNREADABLE', { reason: 'size' }])
  })

  it('NOT_FOUND for a file that does not exist', async () => {
    expect((await failureOf(readMultidataFromZip(join(root, 'missing.zip')))).code).toBe('NOT_FOUND')
  })
})

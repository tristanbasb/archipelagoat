import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { unpickle, type PickleObject, type PickleTuple, type PickleValue } from '@main/core/checks/pickle'
import { AppError } from '@shared/errors'
import { pickle } from '../../helpers/make-pickle.mjs'

// The opcodes, written from pickletools.opcodes: the pickles below are put together byte by byte.
const OP = {
  PROTO: 0x80,
  FRAME: 0x95,
  STOP: 0x2e,
  MARK: 0x28,
  NONE: 0x4e,
  NEWTRUE: 0x88,
  NEWFALSE: 0x89,
  BININT: 0x4a,
  BININT1: 0x4b,
  BININT2: 0x4d,
  LONG1: 0x8a,
  BINFLOAT: 0x47,
  SHORT_BINUNICODE: 0x8c,
  BINUNICODE: 0x58,
  BINUNICODE8: 0x8d,
  SHORT_BINBYTES: 0x43,
  BINBYTES: 0x42,
  EMPTY_LIST: 0x5d,
  APPEND: 0x61,
  APPENDS: 0x65,
  LIST: 0x6c,
  EMPTY_DICT: 0x7d,
  SETITEM: 0x73,
  SETITEMS: 0x75,
  DICT: 0x64,
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  FROZENSET: 0x91,
  EMPTY_TUPLE: 0x29,
  TUPLE: 0x74,
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  GLOBAL: 0x63,
  STACK_GLOBAL: 0x93,
  NEWOBJ: 0x81,
  NEWOBJ_EX: 0x92,
  REDUCE: 0x52,
  BUILD: 0x62,
  MEMOIZE: 0x94,
  BINGET: 0x68,
  LONG_BINGET: 0x6a,
  PUT: 0x70,
  BINPUT: 0x71,
  LONG_BINPUT: 0x72,
} as const

type Part = number | string | Uint8Array

/** Bytes from parts: a number is one byte, a string its UTF-8, a byte array itself. */
function bin(...parts: Part[]): Buffer {
  return Buffer.concat(
    parts.map((part) =>
      typeof part === 'number' ? Buffer.from([part]) : typeof part === 'string' ? Buffer.from(part) : part,
    ),
  )
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}
const f64 = (n: number): Buffer => {
  const b = Buffer.alloc(8)
  b.writeDoubleBE(n)
  return b
}

/** SHORT_BINUNICODE of an ASCII text. */
const str = (text: string): Buffer => bin(OP.SHORT_BINUNICODE, Buffer.byteLength(text), text)
const int1 = (n: number): Buffer => bin(OP.BININT1, n)
const proto = (version = 4): Buffer => bin(OP.PROTO, version)

/** A whole protocol 4 pickle around `parts`. */
const wrap = (...parts: Part[]): Buffer => bin(proto(), ...parts, OP.STOP)
const load = (...parts: Part[]): PickleValue => unpickle(wrap(...parts))

/** The MULTIDATA_UNREADABLE that `fn` throws; fails when it throws anything else. */
function failure(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('MULTIDATA_UNREADABLE')
    return error as AppError
  }
  throw new Error('expected MULTIDATA_UNREADABLE')
}

const reasonOf = (fn: () => unknown): unknown => failure(fn).params?.reason

describe('unpickle: values', () => {
  it('reads None and the booleans', () => {
    expect(load(OP.NONE)).toBeNull()
    expect(load(OP.NEWTRUE)).toBe(true)
    expect(load(OP.NEWFALSE)).toBe(false)
  })

  it('reads BININT, BININT1 and BININT2', () => {
    expect(load(OP.BININT1, 255)).toBe(255)
    expect(load(OP.BININT2, u16(65535))).toBe(65535)
    expect(load(OP.BININT, i32(2 ** 31 - 1))).toBe(2 ** 31 - 1)
    expect(load(OP.BININT, i32(-2))).toBe(-2)
    expect(load(OP.BININT, i32(-(2 ** 31)))).toBe(-(2 ** 31))
  })

  it('reads LONG1 as two’s complement, a number while it is exact and a bigint beyond', () => {
    expect(load(OP.LONG1, 0)).toBe(0)
    expect(load(OP.LONG1, 2, 0xe8, 0x03)).toBe(1000)
    expect(load(OP.LONG1, 1, 0xff)).toBe(-1)
    expect(load(OP.LONG1, 1, 0x80)).toBe(-128)
    // 2**53 - 1 and its negative are the last exact numbers; 2**53 and 2**63 are bigints.
    expect(load(OP.LONG1, 7, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f)).toBe(Number.MAX_SAFE_INTEGER)
    expect(load(OP.LONG1, 7, 0x01, 0, 0, 0, 0, 0, 0xe0)).toBe(Number.MIN_SAFE_INTEGER)
    expect(load(OP.LONG1, 7, 0, 0, 0, 0, 0, 0, 0x20)).toBe(2n ** 53n)
    expect(load(OP.LONG1, 7, 0, 0, 0, 0, 0, 0, 0xe0)).toBe(-(2n ** 53n))
    expect(load(OP.LONG1, 9, 0, 0, 0, 0, 0, 0, 0, 0x80, 0)).toBe(2n ** 63n)
    expect(load(OP.LONG1, 8, 0, 0, 0, 0, 0, 0, 0, 0x80)).toBe(-(2n ** 63n))
  })

  it('reads BINFLOAT as a big-endian double', () => {
    expect(load(OP.BINFLOAT, f64(1.5))).toBe(1.5)
    expect(load(OP.BINFLOAT, f64(-0.1))).toBe(-0.1)
    expect(load(OP.BINFLOAT, f64(Infinity))).toBe(Infinity)
  })

  it('reads SHORT_BINUNICODE, BINUNICODE and BINUNICODE8', () => {
    const accents = Buffer.from('Pokémon ✨')
    expect(load(OP.SHORT_BINUNICODE, accents.length, accents)).toBe('Pokémon ✨')
    expect(load(OP.BINUNICODE, u32(accents.length), accents)).toBe('Pokémon ✨')
    expect(load(OP.BINUNICODE8, u64(BigInt(accents.length)), accents)).toBe('Pokémon ✨')
    expect(load(OP.SHORT_BINUNICODE, 0)).toBe('')
    const long = 'x'.repeat(300)
    expect(load(OP.BINUNICODE, u32(300), long)).toBe(long)
  })

  it('keeps a byte order mark and turns a byte that is not UTF-8 into U+FFFD', () => {
    expect(load(OP.SHORT_BINUNICODE, 4, 0xef, 0xbb, 0xbf, 0x61)).toBe('﻿a')
    expect(load(OP.SHORT_BINUNICODE, 2, 0x61, 0xff)).toBe('a�')
  })

  it('reads SHORT_BINBYTES and BINBYTES as copies', () => {
    expect(load(OP.SHORT_BINBYTES, 3, 1, 2, 3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(load(OP.BINBYTES, u32(2), 9, 8)).toEqual(new Uint8Array([9, 8]))
    const input = wrap(OP.SHORT_BINBYTES, 1, 7)
    const bytes = unpickle(input) as Uint8Array
    bytes[0] = 0
    expect(input[input.length - 2]).toBe(7)
  })
})

describe('unpickle: containers', () => {
  it('reads lists: EMPTY_LIST, APPEND, APPENDS and LIST', () => {
    expect(load(OP.EMPTY_LIST)).toEqual([])
    expect(load(OP.EMPTY_LIST, int1(1), OP.APPEND)).toEqual([1])
    expect(load(OP.EMPTY_LIST, OP.MARK, int1(1), str('a'), OP.NONE, OP.APPENDS)).toEqual([1, 'a', null])
    expect(load(OP.MARK, int1(3), int1(4), OP.LIST)).toEqual([3, 4])
  })

  it('reads dicts as Maps: EMPTY_DICT, SETITEM, SETITEMS and DICT', () => {
    expect(load(OP.EMPTY_DICT)).toEqual(new Map())
    expect(load(OP.EMPTY_DICT, str('a'), int1(1), OP.SETITEM)).toEqual(new Map([['a', 1]]))
    expect(load(OP.EMPTY_DICT, OP.MARK, int1(1), str('one'), int1(2), str('two'), OP.SETITEMS)).toEqual(
      new Map([
        [1, 'one'],
        [2, 'two'],
      ]),
    )
    expect(load(OP.MARK, str('k'), OP.NEWTRUE, OP.DICT)).toEqual(new Map([['k', true]]))
  })

  it('reads sets: EMPTY_SET, ADDITEMS and FROZENSET', () => {
    expect(load(OP.EMPTY_SET)).toEqual(new Set())
    expect(load(OP.EMPTY_SET, OP.MARK, int1(1), int1(2), int1(1), OP.ADDITEMS)).toEqual(new Set([1, 2]))
    expect(load(OP.MARK, str('a'), str('b'), OP.FROZENSET)).toEqual(new Set(['a', 'b']))
  })

  it('reads tuples as { tuple }: EMPTY_TUPLE, TUPLE1, TUPLE2, TUPLE3 and TUPLE', () => {
    expect(load(OP.EMPTY_TUPLE)).toEqual({ tuple: [] })
    expect(load(int1(1), OP.TUPLE1)).toEqual({ tuple: [1] })
    expect(load(int1(1), int1(2), OP.TUPLE2)).toEqual({ tuple: [1, 2] })
    expect(load(int1(1), int1(2), int1(3), OP.TUPLE3)).toEqual({ tuple: [1, 2, 3] })
    expect(load(OP.MARK, int1(1), int1(2), int1(3), int1(4), OP.TUPLE)).toEqual({ tuple: [1, 2, 3, 4] })
  })

  it('keeps a tuple as the key of a dict', () => {
    const value = load(OP.EMPTY_DICT, int1(2), int1(3), OP.TUPLE2, str('pair'), OP.SETITEM)
    expect(value).toEqual(new Map([[{ tuple: [2, 3] }, 'pair']]))
  })
})

describe('unpickle: memo and frames', () => {
  it('MEMOIZE numbers the memo from 0, one entry for each call', () => {
    expect(
      load(OP.MARK, str('a'), OP.MEMOIZE, str('b'), OP.MEMOIZE, OP.BINGET, 1, OP.BINGET, 0, OP.TUPLE),
    ).toEqual({
      tuple: ['a', 'b', 'b', 'a'],
    })
  })

  it('BINGET gives back the very object that was memoized, as Python shares it', () => {
    const pair = load(OP.EMPTY_LIST, OP.MEMOIZE, OP.BINGET, 0, OP.TUPLE2) as { tuple: PickleValue[] }
    expect(pair.tuple[0]).toBe(pair.tuple[1])
  })

  it('LONG_BINGET reaches the memo entries past 255', () => {
    const memoized = Array.from({ length: 300 }, (_, i) => [str(`s${i}`), OP.MEMOIZE])
    expect(load(...memoized.flat(), OP.LONG_BINGET, u32(299))).toBe('s299')
    expect(load(...memoized.flat(), OP.LONG_BINGET, u32(256))).toBe('s256')
    expect(load(...memoized.flat(), OP.BINGET, 255)).toBe('s255')
  })

  it('PUT, BINPUT and LONG_BINPUT store the top of the stack, and a second PUT replaces it', () => {
    expect(load(str('a'), OP.PUT, '0\n', OP.BINGET, 0)).toBe('a')
    expect(load(str('a'), OP.BINPUT, 0, OP.BINGET, 0)).toBe('a')
    expect(load(str('a'), OP.LONG_BINPUT, u32(0), OP.BINGET, 0)).toBe('a')
    expect(load(str('a'), OP.BINPUT, 0, str('b'), OP.BINPUT, 0, OP.BINGET, 0)).toBe('b')
  })

  it('MEMOIZE after a PUT numbers from the size of the memo', () => {
    expect(load(str('a'), OP.PUT, '0\n', str('b'), OP.MEMOIZE, OP.BINGET, 1)).toBe('b')
  })

  it('ignores FRAME, whatever length it announces', () => {
    expect(unpickle(bin(proto(), OP.FRAME, u64(0n), int1(5), OP.STOP))).toBe(5)
    expect(unpickle(bin(proto(), OP.FRAME, u64(2n ** 40n), int1(5), OP.STOP))).toBe(5)
  })

  it('reads protocol 2 to 5, without FRAME or MEMOIZE', () => {
    for (const version of [2, 3, 4, 5]) {
      expect(unpickle(bin(proto(version), OP.EMPTY_LIST, OP.MARK, int1(1), OP.APPENDS, OP.STOP))).toEqual([1])
    }
  })

  it('stops at STOP: what follows is not read', () => {
    expect(unpickle(bin(proto(), int1(1), OP.STOP, 0xff, 0xff))).toBe(1)
  })
})

describe('unpickle: globals and objects', () => {
  const NETWORK_SLOT = { global: { module: 'NetUtils', name: 'NetworkSlot' } }

  it('reads GLOBAL (two lines) and STACK_GLOBAL as markers', () => {
    expect(load(OP.GLOBAL, 'collections\nOrderedDict\n')).toEqual({
      global: { module: 'collections', name: 'OrderedDict' },
    })
    expect(load(str('NetUtils'), str('NetworkSlot'), OP.STACK_GLOBAL)).toEqual(NETWORK_SLOT)
  })

  it('reads NEWOBJ as { class, args, state: null }', () => {
    expect(
      load(
        str('NetUtils'),
        str('NetworkSlot'),
        OP.STACK_GLOBAL,
        str('Claire'),
        str('A Short Hike'),
        OP.TUPLE2,
        OP.NEWOBJ,
      ),
    ).toEqual({ object: { class: NETWORK_SLOT, args: { tuple: ['Claire', 'A Short Hike'] }, state: null } })
  })

  it('reads NEWOBJ_EX with its positional arguments', () => {
    expect(
      load(
        str('NetUtils'),
        str('NetworkSlot'),
        OP.STACK_GLOBAL,
        str('Claire'),
        OP.TUPLE1,
        OP.EMPTY_DICT,
        OP.NEWOBJ_EX,
      ),
    ).toEqual({ object: { class: NETWORK_SLOT, args: { tuple: ['Claire'] }, state: null } })
  })

  it('reads REDUCE as { class, args, state: null }', () => {
    expect(load(str('NetUtils'), str('SlotType'), OP.STACK_GLOBAL, int1(1), OP.TUPLE1, OP.REDUCE)).toEqual({
      object: {
        class: { global: { module: 'NetUtils', name: 'SlotType' } },
        args: { tuple: [1] },
        state: null,
      },
    })
  })

  it('BUILD sets the state of the object, which memoized references share', () => {
    const value = load(
      str('m'),
      str('C'),
      OP.STACK_GLOBAL,
      OP.EMPTY_TUPLE,
      OP.NEWOBJ,
      OP.MEMOIZE,
      OP.EMPTY_DICT,
      str('k'),
      int1(1),
      OP.SETITEM,
      OP.BUILD,
      OP.BINGET,
      0,
      OP.TUPLE2,
    ) as { tuple: { object: { state: PickleValue } }[] }
    expect(value.tuple[0]?.object.state).toEqual(new Map([['k', 1]]))
    expect(value.tuple[1]).toBe(value.tuple[0])
  })

  it('never resolves a global: GLOBAL os system and REDUCE give an object and run nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'goat pickle-'))
    try {
      const marker = join(root, 'ran.txt')
      const command = `echo hacked> "${marker}"`
      const value = load(
        OP.GLOBAL,
        'os\nsystem\n',
        OP.BINUNICODE,
        u32(Buffer.byteLength(command)),
        command,
        OP.TUPLE1,
        OP.REDUCE,
      )
      expect(value).toEqual({
        object: {
          class: { global: { module: 'os', name: 'system' } },
          args: { tuple: [command] },
          state: null,
        },
      })
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not evaluate builtins.eval either', () => {
    expect(
      load(OP.GLOBAL, 'builtins\neval\n', str('__import__("os").system("x")'), OP.TUPLE1, OP.REDUCE),
    ).toEqual({
      object: {
        class: { global: { module: 'builtins', name: 'eval' } },
        args: { tuple: ['__import__("os").system("x")'] },
        state: null,
      },
    })
  })
})

describe('unpickle: the real AP 0.6.8 multidata', () => {
  // The pickle inside tests/fixtures/multidata: the 29 opcodes of spec §3.3, protocol 4, 1 759 memo entries.
  const file = readFileSync(
    fileURLToPath(new URL('../../fixtures/multidata/hk-ash-0.6.8.archipelago', import.meta.url)),
  )
  const real = unpickle(inflateSync(file.subarray(1))) as Map<string, PickleValue>

  it('is a dict with the keys AP writes, in its order', () => {
    expect([...real.keys()]).toEqual([
      'slot_data',
      'slot_info',
      'connect_names',
      'locations',
      'checks_in_area',
      'server_options',
      'er_hint_data',
      'precollected_items',
      'precollected_hints',
      'version',
      'tags',
      'minimum_versions',
      'seed_name',
      'spheres',
      'datapackage',
      'race_mode',
    ])
    expect(real.get('version')).toEqual({ tuple: [0, 6, 8] })
    expect(real.get('seed_name')).toBe('02053695854357871005')
    expect(real.get('tags')).toEqual(['AP'])
    expect(real.get('race_mode')).toBe(0)
    expect(real.get('connect_names')).toEqual(
      new Map([
        ['Claire', { tuple: [0, 1] }],
        ['Knight', { tuple: [0, 2] }],
      ]),
    )
  })

  it('reads the slots as NetworkSlot objects that share their SlotType', () => {
    const info = real.get('slot_info') as Map<number, PickleObject>
    const slotType = {
      object: {
        class: { global: { module: 'NetUtils', name: 'SlotType' } },
        args: { tuple: [1] },
        state: null,
      },
    }
    expect(info.get(1)).toEqual({
      object: {
        class: { global: { module: 'NetUtils', name: 'NetworkSlot' } },
        args: { tuple: ['Claire', 'A Short Hike', slotType, { tuple: [] }] },
        state: null,
      },
    })
    expect(info.get(2)?.object.args).toEqual({ tuple: ['Knight', 'Hollow Knight', slotType, { tuple: [] }] })
    const [first, second] = [info.get(1), info.get(2)].map(
      (slot) => (slot?.object.args as PickleTuple).tuple[2],
    )
    expect(first).toBe(second)
  })

  it('reads the locations of each slot as {location: (item, player, flags)}', () => {
    const locations = real.get('locations') as Map<number, Map<number, PickleValue>>
    expect([...locations].map(([slot, checks]) => [slot, checks.size])).toEqual([
      [1, 131],
      [2, 203],
    ])
    expect(locations.get(1)?.get(83001)).toEqual({ tuple: [16777276, 2, 1] })
  })
})

describe('unpickle: what the writer of the tests writes', () => {
  it('reads back every kind of value', () => {
    const shared: PickleValue[] = [1]
    const value: PickleValue = new Map<PickleValue, PickleValue>([
      ['none', null],
      ['flags', [true, false]],
      ['ints', [0, 255, 256, 65535, 65536, -1, 2 ** 31, -(2 ** 31) - 1, 2 ** 53 - 1]],
      ['big', [2n ** 80n, -(2n ** 80n)]],
      ['float', 0.25],
      ['text', ['', 'Pokémon', 'x'.repeat(400)]],
      ['bytes', [new Uint8Array([1, 2]), new Uint8Array(300)]],
      ['set', new Set([1, 'a'])],
      ['tuple', { tuple: [{ tuple: [] }, { tuple: [1] }, { tuple: [1, 2, 3, 4, 5] }] }],
      ['shared', [shared, shared]],
      [{ tuple: [1, 2] }, new Map([[3, 4]])],
      ['global', { global: { module: 'a', name: 'b' } }],
      [
        'object',
        { object: { class: { global: { module: 'a', name: 'b' } }, args: { tuple: [1] }, state: new Map() } },
      ],
    ])
    const back = unpickle(pickle(value)) as Map<PickleValue, PickleValue>
    expect(back).toEqual(value)
    const [first, second] = back.get('shared') as PickleValue[][]
    expect(first).toBe(second)
  })

  it('reads long lists and dicts, which are written in batches', () => {
    const list = Array.from({ length: 2500 }, (_, i) => i)
    const dict = new Map(list.map((i) => [i, `v${i}`]))
    expect(unpickle(pickle(list))).toEqual(list)
    expect(unpickle(pickle(dict))).toEqual(dict)
    expect(unpickle(pickle(new Set(list)))).toEqual(new Set(list))
  })
})

describe('unpickle: opcodes outside the list', () => {
  // Opcodes that pickletools knows and that AP never writes into a multidata. Each is the first after PROTO.
  const FORBIDDEN: [name: string, code: number][] = [
    ['INST', 0x69],
    ['OBJ', 0x6f],
    ['PERSID', 0x50],
    ['BINPERSID', 0x51],
    ['EXT1', 0x82],
    ['EXT2', 0x83],
    ['EXT4', 0x84],
    ['LONG4', 0x8b],
    ['BINBYTES8', 0x8e],
    ['BYTEARRAY8', 0x96],
    ['NEXT_BUFFER', 0x97],
    ['READONLY_BUFFER', 0x98],
    ['GET', 0x67],
    ['POP', 0x30],
    ['POP_MARK', 0x31],
    ['DUP', 0x32],
    ['INT', 0x49],
    ['LONG', 0x4c],
    ['FLOAT', 0x46],
    ['STRING', 0x53],
    ['BINSTRING', 0x54],
    ['SHORT_BINSTRING', 0x55],
    ['UNICODE', 0x56],
    ['a byte no opcode has', 0xff],
  ]

  it.each(FORBIDDEN)('%s is refused', (_name, code) => {
    expect(reasonOf(() => unpickle(bin(proto(), code, '1\n2\n', OP.STOP)))).toBe('opcode')
  })

  it('refuses a protocol outside 2 to 5', () => {
    for (const version of [0, 1, 6, 255]) {
      expect(reasonOf(() => unpickle(bin(proto(version), OP.NONE, OP.STOP)))).toBe('opcode')
    }
  })

  it('refuses STACK_GLOBAL of something that is not two strings, and BUILD of something that is no object', () => {
    expect(reasonOf(() => load(int1(1), str('x'), OP.STACK_GLOBAL))).toBe('opcode')
    expect(reasonOf(() => load(OP.EMPTY_LIST, OP.EMPTY_DICT, OP.BUILD))).toBe('opcode')
  })

  it('names the opcode and where it is in the detail', () => {
    expect(failure(() => unpickle(bin(proto(), OP.NONE, 0x69))).detail).toMatch(/0x69.*offset 3/)
  })
})

describe('unpickle: truncated and damaged', () => {
  it('reads nothing from an empty input', () => {
    expect(reasonOf(() => unpickle(new Uint8Array()))).toBe('truncated')
  })

  it('refuses every prefix of a pickle', () => {
    const whole = pickle(
      new Map<PickleValue, PickleValue>([
        ['name', 'Claire'],
        ['big', 2n ** 70n],
        ['list', [1, 300, 70000, 0.5, null, true, new Uint8Array([1])]],
        ['tuple', { tuple: [1, 2, 3, 4] }],
        [
          'object',
          {
            object: {
              class: { global: { module: 'NetUtils', name: 'NetworkSlot' } },
              args: { tuple: ['a'] },
              state: new Set([1]),
            },
          },
        ],
      ]),
    )
    expect(unpickle(whole)).toBeInstanceOf(Map)
    for (let length = 0; length < whole.length; length++) {
      expect(
        reasonOf(() => unpickle(whole.subarray(0, length))),
        `${length} bytes of ${whole.length}`,
      ).toBe('truncated')
    }
  })

  it('refuses a length that goes past the end without allocating it', () => {
    expect(reasonOf(() => load(OP.BINUNICODE, u32(0xffffffff), 'abc'))).toBe('truncated')
    expect(reasonOf(() => load(OP.BINUNICODE8, u64(2n ** 62n), 'abc'))).toBe('truncated')
    expect(reasonOf(() => load(OP.BINUNICODE8, u64(2n ** 64n - 1n)))).toBe('truncated')
    expect(reasonOf(() => load(OP.BINBYTES, u32(100), 1))).toBe('truncated')
    expect(reasonOf(() => load(OP.SHORT_BINBYTES, 3, 1))).toBe('truncated')
    expect(reasonOf(() => load(OP.LONG1, 4, 1, 2))).toBe('truncated')
    expect(reasonOf(() => unpickle(bin(proto(), OP.FRAME, 1, 2, 3)))).toBe('truncated')
  })

  it('refuses a stream that does not end with STOP', () => {
    expect(reasonOf(() => unpickle(bin(proto(), OP.NONE)))).toBe('truncated')
  })

  const DAMAGED: [name: string, parts: Part[]][] = [
    ['STOP with nothing to return', []],
    ['an unknown memo index', [OP.BINGET, 0]],
    ['a long memo index past the memo', [str('a'), OP.MEMOIZE, OP.LONG_BINGET, u32(1)]],
    ['PUT past the end of the memo', [str('a'), OP.BINPUT, 3]],
    ['PUT that is no number', [str('a'), OP.PUT, 'x\n']],
    ['PUT without its line end', [str('a'), OP.PUT, '0']],
    ['SETITEM on a list', [OP.EMPTY_LIST, int1(1), int1(2), OP.SETITEM]],
    ['APPEND on a dict', [OP.EMPTY_DICT, int1(1), OP.APPEND]],
    ['ADDITEMS on a list', [OP.EMPTY_LIST, OP.MARK, int1(1), OP.ADDITEMS]],
    ['APPENDS without MARK', [OP.EMPTY_LIST, int1(1), OP.APPENDS]],
    ['SETITEMS with an odd number of items', [OP.EMPTY_DICT, OP.MARK, int1(1), OP.SETITEMS]],
    ['DICT with an odd number of items', [OP.MARK, int1(1), OP.DICT]],
    ['TUPLE2 with one item', [int1(1), OP.TUPLE2]],
    ['TUPLE1 below a MARK', [int1(1), OP.MARK, OP.TUPLE1]],
    ['NEWOBJ without arguments', [OP.GLOBAL, 'a\nb\n', OP.NEWOBJ]],
    ['MEMOIZE of nothing', [OP.MEMOIZE]],
    ['a GLOBAL line longer than a name can be', [OP.GLOBAL, `${'x'.repeat(2000)}\nname\n`]],
  ]

  it.each(DAMAGED)('refuses %s', (_name, parts) => {
    expect(reasonOf(() => load(...parts))).toBe('truncated')
  })
})

describe('unpickle: depth', () => {
  const nested = (levels: number): PickleValue => {
    let value: PickleValue = []
    for (let i = 1; i < levels; i++) value = [value]
    return value
  }

  it('reads 64 levels of containers and refuses 65', () => {
    expect(unpickle(pickle(nested(64)))).toEqual(nested(64))
    expect(reasonOf(() => unpickle(pickle(nested(65))))).toBe('depth')
  })

  it('counts every kind of container', () => {
    const around = (value: PickleValue, kind: number): PickleValue =>
      [
        (v: PickleValue) => [v],
        (v: PickleValue) => ({ tuple: [v] }),
        (v: PickleValue) => new Map([['k', v]]),
        (v: PickleValue) => new Set([v]),
        (v: PickleValue) => ({ object: { class: null, args: null, state: v } }),
        (v: PickleValue) => ({ object: { class: v, args: null, state: null } }),
        (v: PickleValue) => ({ object: { class: null, args: v, state: null } }),
        (v: PickleValue) => new Map([[v, 'k']]),
      ][kind % 8]!(value)
    let value: PickleValue = []
    for (let i = 1; i < 64; i++) value = around(value, i)
    expect(() => unpickle(pickle(value))).not.toThrow()
    expect(reasonOf(() => unpickle(pickle(around(value, 0))))).toBe('depth')
  })

  it('takes the limit it is given', () => {
    expect(unpickle(pickle(nested(3)), { maxDepth: 3 })).toEqual(nested(3))
    expect(reasonOf(() => unpickle(pickle(nested(4)), { maxDepth: 3 }))).toBe('depth')
  })

  it('measures the deepest path to a shared value, not the first one it is met on', () => {
    const shared: PickleValue[] = []
    let deep: PickleValue = [shared]
    for (let i = 0; i < 62; i++) deep = [deep]
    // `shared` is a child of the root and also 64 levels down: that path has 65 containers.
    expect(reasonOf(() => unpickle(pickle([shared, deep])))).toBe('depth')
    const shallow: PickleValue = [[shared], [shared]]
    expect(unpickle(pickle(shallow))).toEqual([[[]], [[]]])
  })

  it('walks a value shared by many parents once', () => {
    // 40 levels that each hold the level below twice: 2**40 paths, 41 values.
    let value: PickleValue = []
    for (let i = 0; i < 40; i++) value = [value, value]
    expect(unpickle(pickle(value))).toBeInstanceOf(Array)
  })

  it('refuses a container that holds itself, however deep the limit', () => {
    const loop: PickleValue[] = []
    loop.push(loop)
    const map = new Map<PickleValue, PickleValue>()
    map.set('self', map)
    for (const value of [loop, map]) {
      for (const maxDepth of [64, 1_000_000_000]) {
        const error = failure(() => unpickle(pickle(value), { maxDepth }))
        expect([error.params, error.detail]).toEqual([
          { reason: 'depth' },
          expect.stringContaining('holds itself'),
        ])
      }
    }
  })

  it('refuses a nesting of 200 000 levels without running out of stack', () => {
    const levels = 200_000
    const bytes = bin(
      proto(),
      Buffer.alloc(levels, OP.EMPTY_LIST),
      Buffer.alloc(levels - 1, OP.APPEND),
      OP.STOP,
    )
    expect(reasonOf(() => unpickle(bytes))).toBe('depth')
  })
})

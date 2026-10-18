// A writer of pickles for the tests: protocol 4, laid out the way CPython's `pickle.dumps(value, 4)`
// does it (PROTO, one FRAME, MEMOIZE after each object, BINGET for a value met again), over the values
// the reader returns (src/main/core/checks/pickle.ts), and the `.archipelago` of a generation
// (Main.py:290-360) as far as the app reads it. The real file in tests/fixtures/multidata is what
// the reader is checked against; this is for the files that file cannot be (other shapes, hostile ones).
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

// The opcodes written here (pickletools.opcodes).
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
  SHORT_BINBYTES: 0x43,
  BINBYTES: 0x42,
  EMPTY_LIST: 0x5d,
  APPEND: 0x61,
  APPENDS: 0x65,
  EMPTY_DICT: 0x7d,
  SETITEM: 0x73,
  SETITEMS: 0x75,
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  EMPTY_TUPLE: 0x29,
  TUPLE: 0x74,
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  STACK_GLOBAL: 0x93,
  NEWOBJ: 0x81,
  REDUCE: 0x52,
  BUILD: 0x62,
  MEMOIZE: 0x94,
  BINGET: 0x68,
  LONG_BINGET: 0x6a,
}

/** CPython sends containers in batches of this many items. */
const BATCH = 1000

const byte = (n) => Buffer.from([n])

function uint(size, n) {
  const buffer = Buffer.alloc(size)
  buffer.writeUIntLE(n, 0, size)
  return buffer
}

const uint64 = (n) => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(n))
  return buffer
}

/** Minimal little-endian two's complement of `n`, the argument of LONG1. */
function twosComplement(n) {
  const bytes = []
  let rest = n
  for (;;) {
    const low = Number(rest & 0xffn)
    bytes.push(low)
    rest >>= 8n
    if ((rest === 0n && (low & 0x80) === 0) || (rest === -1n && (low & 0x80) !== 0)) break
  }
  return Buffer.from(bytes)
}

/**
 * The pickle of `value`, protocol 4. Takes what the reader returns, plus `{ reduce: { class, args } }`
 * for an object made by REDUCE instead of NEWOBJ. A string met again is a BINGET, like CPython's
 * interned strings, and so is an object met again: a list that holds itself is written as it is in
 * Python. Integers are the numbers that have no fraction; a float needs a fraction.
 */
export function pickle(value) {
  const parts = []
  const memo = new Map()
  const put = (...chunks) => parts.push(...chunks)

  function remember(key) {
    put(byte(OP.MEMOIZE))
    memo.set(key, memo.size)
  }

  function recall(key) {
    const index = memo.get(key)
    if (index === undefined) return false
    put(
      index < 256
        ? Buffer.concat([byte(OP.BINGET), byte(index)])
        : Buffer.concat([byte(OP.LONG_BINGET), uint(4, index)]),
    )
    return true
  }

  function saveInt(n) {
    if (n >= 0 && n < 256) put(byte(OP.BININT1), byte(n))
    else if (n >= 0 && n < 65536) put(byte(OP.BININT2), uint(2, n))
    else if (n >= -(2 ** 31) && n < 2 ** 31) {
      const buffer = Buffer.alloc(4)
      buffer.writeInt32LE(n)
      put(byte(OP.BININT), buffer)
    } else {
      const bytes = twosComplement(BigInt(n))
      put(byte(OP.LONG1), byte(bytes.length), bytes)
    }
  }

  function saveFloat(n) {
    const buffer = Buffer.alloc(8)
    buffer.writeDoubleBE(n)
    put(byte(OP.BINFLOAT), buffer)
  }

  function saveString(text) {
    if (recall(text)) return
    const bytes = Buffer.from(text, 'utf8')
    put(
      bytes.length < 256
        ? Buffer.concat([byte(OP.SHORT_BINUNICODE), byte(bytes.length)])
        : Buffer.concat([byte(OP.BINUNICODE), uint(4, bytes.length)]),
      bytes,
    )
    remember(text)
  }

  function saveBytes(data) {
    if (recall(data)) return
    const bytes = Buffer.from(data)
    put(
      bytes.length < 256
        ? Buffer.concat([byte(OP.SHORT_BINBYTES), byte(bytes.length)])
        : Buffer.concat([byte(OP.BINBYTES), uint(4, bytes.length)]),
      bytes,
    )
    remember(data)
  }

  /** `items` in batches: one item alone has its own opcode when `single` is given. */
  function saveBatches(items, saveItem, batchOp, single) {
    for (let from = 0; from < items.length; from += BATCH) {
      const batch = items.slice(from, from + BATCH)
      if (batch.length === 1 && single !== undefined) {
        saveItem(batch[0])
        put(byte(single))
      } else {
        put(byte(OP.MARK))
        for (const item of batch) saveItem(item)
        put(byte(batchOp))
      }
    }
  }

  function saveTuple(items) {
    if (items.length === 0) return put(byte(OP.EMPTY_TUPLE))
    if (items.length <= 3) {
      for (const item of items) save(item)
      put(byte([OP.TUPLE1, OP.TUPLE2, OP.TUPLE3][items.length - 1]))
    } else {
      put(byte(OP.MARK))
      for (const item of items) save(item)
      put(byte(OP.TUPLE))
    }
  }

  function save(v) {
    if (v === null) return put(byte(OP.NONE))
    if (v === true) return put(byte(OP.NEWTRUE))
    if (v === false) return put(byte(OP.NEWFALSE))
    if (typeof v === 'bigint') {
      const bytes = twosComplement(v)
      return put(byte(OP.LONG1), byte(bytes.length), bytes)
    }
    if (typeof v === 'number') return Number.isInteger(v) ? saveInt(v) : saveFloat(v)
    if (typeof v === 'string') return saveString(v)
    if (v instanceof Uint8Array) return saveBytes(v)
    if (recall(v)) return
    if (Array.isArray(v)) {
      put(byte(OP.EMPTY_LIST))
      remember(v)
      return saveBatches(v, save, OP.APPENDS, OP.APPEND)
    }
    if (v instanceof Map) {
      put(byte(OP.EMPTY_DICT))
      remember(v)
      const pairs = [...v]
      return saveBatches(
        pairs,
        ([key, item]) => {
          save(key)
          save(item)
        },
        OP.SETITEMS,
        OP.SETITEM,
      )
    }
    if (v instanceof Set) {
      put(byte(OP.EMPTY_SET))
      remember(v)
      return saveBatches([...v], save, OP.ADDITEMS)
    }
    if ('tuple' in v) {
      saveTuple(v.tuple)
      if (v.tuple.length > 0) remember(v)
      return
    }
    if ('global' in v) {
      saveString(v.global.module)
      saveString(v.global.name)
      put(byte(OP.STACK_GLOBAL))
      return remember(v)
    }
    if ('reduce' in v) {
      save(v.reduce.class)
      save(v.reduce.args)
      put(byte(OP.REDUCE))
      return remember(v)
    }
    // { object }: NEWOBJ, then BUILD for a state.
    save(v.object.class)
    save(v.object.args)
    put(byte(OP.NEWOBJ))
    remember(v)
    if (v.object.state !== null) {
      save(v.object.state)
      put(byte(OP.BUILD))
    }
  }

  save(value)
  const body = Buffer.concat([...parts, byte(OP.STOP)])
  return Buffer.concat([byte(OP.PROTO), byte(4), byte(OP.FRAME), uint64(body.length), body])
}

const netUtils = (name) => ({ global: { module: 'NetUtils', name } })

/** AP's `SlotType.player`. */
const PLAYER = 1

/**
 * A multidata, as AP writes it (BaseClasses/Main.py): the format byte 3, then the zlib of a pickle of
 * a dict. `slots` are numbered from 1; each has `checks` locations, and each game a datapackage that
 * lists as many locations as its biggest slot (a real one lists all of the game's).
 */
export function pickleMultidata({ slots }) {
  const slotType = { reduce: { class: netUtils('SlotType'), args: { tuple: [PLAYER] } } }
  const slotInfo = new Map()
  const connectNames = new Map()
  const locations = new Map()
  const biggest = new Map([['Archipelago', 2]])
  slots.forEach(({ name, game, checks }, i) => {
    const slot = i + 1
    const object = {
      class: netUtils('NetworkSlot'),
      args: { tuple: [name, game, slotType, { tuple: [] }] },
      state: null,
    }
    slotInfo.set(slot, { object })
    connectNames.set(name, { tuple: [0, slot] })
    // {location id: (item id, receiving slot, flags)}
    locations.set(
      slot,
      new Map(Array.from({ length: checks }, (_, n) => [slot * 100_000 + n, { tuple: [n + 1, slot, 0] }])),
    )
    biggest.set(game, Math.max(biggest.get(game) ?? 0, checks))
  })
  const datapackage = new Map(
    [...biggest].map(([game, max]) => [
      game,
      new Map([
        [
          'location_name_to_id',
          new Map(Array.from({ length: max }, (_, n) => [`${game} ${n + 1}`, 1000 + n])),
        ],
        ['checksum', createHash('sha1').update(game).digest('hex')],
      ]),
    ]),
  )
  const multidata = new Map([
    ['slot_info', slotInfo],
    ['connect_names', connectNames],
    ['locations', locations],
    ['datapackage', datapackage],
  ])
  return Buffer.concat([byte(3), deflateSync(pickle(multidata), { level: 9 })])
}

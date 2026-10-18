// A reader for the pickles Archipelago writes into a multidata (spec §3.3). It reads data and runs
// nothing: a closed list of opcodes (the 29 a real 0.6.8 file uses, plus the ones other protocols and
// worlds write for the same kinds of value), a stack machine with no recursion, and no import. A global
// (`NetUtils.NetworkSlot`, or `os.system` in a hostile file) is only a name; an object made from one is a
// bag of what it was made with. Python's `pickle` would call them; this never does.
import { AppError } from '@shared/errors'

/** A tuple: Python's `tuple`, told apart from a list. */
export interface PickleTuple {
  tuple: PickleValue[]
}

/** A class or function by name (GLOBAL, STACK_GLOBAL). It is never looked up. */
export interface PickleGlobal {
  global: { module: string; name: string }
}

/**
 * What REDUCE, NEWOBJ and NEWOBJ_EX made: `class` called with `args` (a tuple), and the `state` that BUILD
 * gave it (null until then).
 */
export interface PickleObject {
  object: { class: PickleValue; args: PickleValue; state: PickleValue }
}

/**
 * What a pickle holds: a dict is a Map (any key), a list an array, a set or frozenset a Set, an int a
 * number while it is exact and a bigint past that. A value that the pickle uses twice is the same object
 * here, as in Python: a pickle can describe far more paths than it has values, so walk it with a visited set.
 */
export type PickleValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | PickleValue[]
  | PickleTuple
  | Map<PickleValue, PickleValue>
  | Set<PickleValue>
  | PickleGlobal
  | PickleObject

export interface PickleLimits {
  /** The most containers one inside the other. Default: 64. */
  maxDepth?: number
  /** The most values the pickle may create (the stack, the MARKs and the memo are bounded by it). Default: `MAX_VALUES`. */
  maxValues?: number
  /** The most entries one list, dict, set or tuple may have. Default: `MAX_ENTRIES`. */
  maxEntries?: number
}

/** Why a multidata cannot be read (the `reason` of MULTIDATA_UNREADABLE). */
export type UnreadableReason = 'version' | 'size' | 'shape' | 'opcode' | 'truncated' | 'depth'

/** The error of a file that cannot be read; `detail` says where and what, for the log. */
export function unreadable(reason: UnreadableReason, detail: string): AppError {
  return new AppError('MULTIDATA_UNREADABLE', { reason }, { detail })
}

export const isPickleTuple = (value: PickleValue | undefined): value is PickleTuple =>
  typeof value === 'object' && value !== null && 'tuple' in value

export const isPickleObject = (value: PickleValue | undefined): value is PickleObject =>
  typeof value === 'object' && value !== null && 'object' in value

const DEFAULT_MAX_DEPTH = 64

/**
 * The values a pickle may create (every push on the stack, scalars and containers alike). A value costs
 * a few dozen bytes to a few hundred, so this keeps the memory of a read bounded whatever the file
 * inflates to: one opcode byte can make one value, and the inflated size alone (256 MiB) would allow 256
 * million. The stack, the MARK stack and the memo are bounded by it too, and the table of the depth walk
 * (one entry per container) stays under the 2**24 entries a Map can hold.
 */
export const MAX_VALUES = 8_000_000

/** The entries one container may have: a JavaScript Map or Set cannot hold more than 2**24 anyway. */
export const MAX_ENTRIES = 2 ** 24

// The opcodes (pickletools.opcodes). Any other byte stops the read.
const OP = {
  // Protocol and framing
  PROTO: 0x80,
  FRAME: 0x95,
  STOP: 0x2e,
  MARK: 0x28,
  // Scalars
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
  // Containers
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
  // Globals and objects
  GLOBAL: 0x63,
  STACK_GLOBAL: 0x93,
  NEWOBJ: 0x81,
  NEWOBJ_EX: 0x92,
  REDUCE: 0x52,
  BUILD: 0x62,
  // Memo
  MEMOIZE: 0x94,
  BINGET: 0x68,
  LONG_BINGET: 0x6a,
  PUT: 0x70,
  BINPUT: 0x71,
  LONG_BINPUT: 0x72,
} as const

/** The protocols the reader knows: 2 added NEWOBJ and LONG1, 5 only adds opcodes this does not read. */
const MIN_PROTOCOL = 2
const MAX_PROTOCOL = 5

/** `PUT` writes the index in decimal; no real one has more digits than this. */
const MAX_PUT_DIGITS = 10

/** The longest line GLOBAL and PUT read: a module or a class name is far shorter. */
const MAX_LINE_BYTES = 1024

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/** A string that is not UTF-8 becomes U+FFFD instead of stopping the read, and a BOM stays in it. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })

const truncated = (detail: string): AppError => unreadable('truncated', detail)
const tooBig = (detail: string): AppError => unreadable('size', detail)
const refused = (detail: string): AppError => unreadable('opcode', detail)

/** The stack machine of one pickle. */
class Machine {
  private pos = 0
  private readonly view: DataView
  private readonly stack: PickleValue[] = []
  /** Where each open MARK sits in `stack`. */
  private readonly marks: number[] = []
  private readonly memo: PickleValue[] = []
  /** Values pushed so far, against `maxValues`. */
  private created = 0

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxValues: number,
    private readonly maxEntries: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  // --- the bytes ---

  private need(count: number): void {
    if (count > this.bytes.length - this.pos) {
      throw truncated(
        `the data ends at byte ${this.bytes.length}, ${count} more needed at offset ${this.pos}`,
      )
    }
  }

  private u8(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  private u16(): number {
    this.need(2)
    const value = this.view.getUint16(this.pos, true)
    this.pos += 2
    return value
  }

  private u32(): number {
    this.need(4)
    const value = this.view.getUint32(this.pos, true)
    this.pos += 4
    return value
  }

  private i32(): number {
    this.need(4)
    const value = this.view.getInt32(this.pos, true)
    this.pos += 4
    return value
  }

  /** A length of 8 bytes. One past 2**53 is rounded, which is still past the end of the data for `take` to refuse. */
  private length64(): number {
    this.need(8)
    const length = Number(this.view.getBigUint64(this.pos, true))
    this.pos += 8
    return length
  }

  /** The next `count` bytes, as a view of the input. */
  private take(count: number): Uint8Array {
    this.need(count)
    const slice = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return slice
  }

  private text(count: number): string {
    return utf8.decode(this.take(count))
  }

  /** The text up to the next line end (not included), as GLOBAL and PUT write their arguments. */
  private line(): string {
    const end = this.bytes.indexOf(0x0a, this.pos)
    if (end === -1) throw truncated(`no line end after offset ${this.pos}`)
    if (end - this.pos > MAX_LINE_BYTES) throw this.damaged('a line longer than a name can be')
    return this.text(end - this.pos + 1).slice(0, -1)
  }

  // --- the stack ---

  /** The lowest index the open frame (the part of the stack above the last MARK) may reach. */
  private get floor(): number {
    return this.marks[this.marks.length - 1] ?? 0
  }

  private damaged(what: string): AppError {
    return truncated(`${what} at offset ${this.pos}`)
  }

  private pop(): PickleValue {
    if (this.stack.length <= this.floor) throw this.damaged('stack underflow')
    return this.stack.pop() as PickleValue
  }

  private top(): PickleValue {
    if (this.stack.length <= this.floor) throw this.damaged('stack underflow')
    return this.stack[this.stack.length - 1] as PickleValue
  }

  /** What was pushed since the last MARK, which is closed. */
  private popMark(): PickleValue[] {
    const mark = this.marks.pop()
    if (mark === undefined) throw this.damaged('no MARK')
    return this.stack.splice(mark)
  }

  /** Every value goes on the stack through here: the budget counts them, so the stack cannot outgrow it. */
  private push(value: PickleValue): void {
    if (++this.created > this.maxValues) throw tooBig(`more than ${this.maxValues} values`)
    this.stack.push(value)
  }

  private mark(): void {
    if (this.marks.length >= this.maxValues) throw tooBig(`more than ${this.maxValues} open MARKs`)
    this.marks.push(this.stack.length)
  }

  private remember(index: number, value: PickleValue): void {
    // Python numbers the memo as it fills it, so an index past the end is a hole nothing writes.
    if (index > this.memo.length)
      throw this.damaged(`memo index ${index} past the ${this.memo.length} entries`)
    if (index === this.memo.length && index >= this.maxValues) {
      throw tooBig(`a memo of more than ${this.maxValues} entries`)
    }
    this.memo[index] = value
  }

  private memoize(): void {
    this.remember(this.memo.length, this.top())
  }

  /** A container of `count` entries must be one a JavaScript Map or array can hold. */
  private fits(count: number): void {
    if (count > this.maxEntries) throw tooBig(`a container of more than ${this.maxEntries} entries`)
  }

  private sized(items: PickleValue[]): PickleValue[] {
    this.fits(items.length)
    return items
  }

  private recall(index: number): void {
    if (index >= this.memo.length) throw this.damaged(`unknown memo index ${index}`)
    this.push(this.memo[index] as PickleValue)
  }

  private putFromLine(): void {
    const digits = this.line()
    if (digits.length > MAX_PUT_DIGITS || !/^\d+$/.test(digits)) throw this.damaged('PUT without an index')
    this.remember(Number(digits), this.top())
  }

  // --- values ---

  private long1(): PickleValue {
    const count = this.u8()
    const bytes = this.take(count)
    let value = 0n
    for (let i = count - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] as number)
    if (count > 0 && ((bytes[count - 1] as number) & 0x80) !== 0) value -= 1n << BigInt(8 * count)
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value
  }

  private stackGlobal(): PickleGlobal {
    const name = this.pop()
    const module = this.pop()
    if (typeof module !== 'string' || typeof name !== 'string') {
      throw refused(`STACK_GLOBAL of something that is not two strings, at offset ${this.pos}`)
    }
    return { global: { module, name } }
  }

  private construct(): PickleObject {
    const args = this.pop()
    return { object: { class: this.pop(), args, state: null } }
  }

  private build(): void {
    const state = this.pop()
    const target = this.top()
    if (!isPickleObject(target))
      throw refused(`BUILD of something that is not an object, at offset ${this.pos}`)
    target.object.state = state
  }

  // --- containers ---

  private setItem(items: PickleValue[]): void {
    const target = this.top()
    if (!(target instanceof Map)) throw this.damaged('SETITEM on something that is not a dict')
    if (items.length % 2 !== 0) throw this.damaged('a key without a value')
    this.fits(target.size + items.length / 2)
    for (let i = 0; i < items.length; i += 2) target.set(items[i] as PickleValue, items[i + 1] as PickleValue)
  }

  private append(items: PickleValue[]): void {
    const target = this.top()
    if (!Array.isArray(target)) throw this.damaged('APPEND on something that is not a list')
    this.fits(target.length + items.length)
    for (const item of items) target.push(item)
  }

  private addItems(items: PickleValue[]): void {
    const target = this.top()
    if (!(target instanceof Set)) throw this.damaged('ADDITEMS on something that is not a set')
    this.fits(target.size + items.length)
    for (const item of items) target.add(item)
  }

  private dict(items: PickleValue[]): Map<PickleValue, PickleValue> {
    if (items.length % 2 !== 0) throw this.damaged('a key without a value')
    this.fits(items.length / 2)
    const dict = new Map<PickleValue, PickleValue>()
    for (let i = 0; i < items.length; i += 2) dict.set(items[i] as PickleValue, items[i + 1] as PickleValue)
    return dict
  }

  /** Runs to STOP and returns what it leaves on top of the stack. */
  run(): PickleValue {
    for (;;) {
      const at = this.pos
      const op = this.u8()
      switch (op) {
        case OP.PROTO: {
          const version = this.u8()
          if (version < MIN_PROTOCOL || version > MAX_PROTOCOL) {
            throw refused(`protocol ${version}, only ${MIN_PROTOCOL} to ${MAX_PROTOCOL} are read`)
          }
          break
        }
        case OP.FRAME:
          // The length only tells how much to read ahead; the opcodes after it do not depend on it.
          this.take(8)
          break
        case OP.STOP:
          return this.pop()
        case OP.MARK:
          this.mark()
          break

        case OP.NONE:
          this.push(null)
          break
        case OP.NEWTRUE:
          this.push(true)
          break
        case OP.NEWFALSE:
          this.push(false)
          break
        case OP.BININT:
          this.push(this.i32())
          break
        case OP.BININT1:
          this.push(this.u8())
          break
        case OP.BININT2:
          this.push(this.u16())
          break
        case OP.LONG1:
          this.push(this.long1())
          break
        case OP.BINFLOAT:
          this.need(8)
          this.push(this.view.getFloat64(this.pos, false))
          this.pos += 8
          break
        case OP.SHORT_BINUNICODE:
          this.push(this.text(this.u8()))
          break
        case OP.BINUNICODE:
          this.push(this.text(this.u32()))
          break
        case OP.BINUNICODE8:
          this.push(this.text(this.length64()))
          break
        case OP.SHORT_BINBYTES:
          // A copy: the result must not keep the whole input alive, nor change with it.
          this.push(new Uint8Array(this.take(this.u8())))
          break
        case OP.BINBYTES:
          this.push(new Uint8Array(this.take(this.u32())))
          break

        case OP.EMPTY_LIST:
          this.push([])
          break
        case OP.APPEND:
          this.append([this.pop()])
          break
        case OP.APPENDS:
          this.append(this.popMark())
          break
        case OP.LIST:
          this.push(this.sized(this.popMark()))
          break
        case OP.EMPTY_DICT:
          this.push(new Map())
          break
        case OP.SETITEM: {
          const value = this.pop()
          this.setItem([this.pop(), value])
          break
        }
        case OP.SETITEMS:
          this.setItem(this.popMark())
          break
        case OP.DICT:
          this.push(this.dict(this.popMark()))
          break
        case OP.EMPTY_SET:
          this.push(new Set())
          break
        case OP.ADDITEMS:
          this.addItems(this.popMark())
          break
        case OP.FROZENSET:
          this.push(new Set(this.sized(this.popMark())))
          break
        case OP.EMPTY_TUPLE:
          this.push({ tuple: [] })
          break
        case OP.TUPLE:
          this.push({ tuple: this.sized(this.popMark()) })
          break
        case OP.TUPLE1:
          this.push({ tuple: [this.pop()] })
          break
        case OP.TUPLE2: {
          const second = this.pop()
          this.push({ tuple: [this.pop(), second] })
          break
        }
        case OP.TUPLE3: {
          const third = this.pop()
          const second = this.pop()
          this.push({ tuple: [this.pop(), second, third] })
          break
        }

        case OP.GLOBAL: {
          const module = this.line()
          this.push({ global: { module, name: this.line() } })
          break
        }
        case OP.STACK_GLOBAL:
          this.push(this.stackGlobal())
          break
        case OP.NEWOBJ:
        case OP.REDUCE:
          this.push(this.construct())
          break
        case OP.NEWOBJ_EX:
          // The keyword arguments are dropped: nothing here is ever called with them.
          this.pop()
          this.push(this.construct())
          break
        case OP.BUILD:
          this.build()
          break

        case OP.MEMOIZE:
          this.memoize()
          break
        case OP.BINGET:
          this.recall(this.u8())
          break
        case OP.LONG_BINGET:
          this.recall(this.u32())
          break
        case OP.PUT:
          this.putFromLine()
          break
        case OP.BINPUT:
          this.remember(this.u8(), this.top())
          break
        case OP.LONG_BINPUT:
          this.remember(this.u32(), this.top())
          break

        default:
          throw refused(`opcode 0x${op.toString(16).padStart(2, '0')} at offset ${at}, outside the list`)
      }
    }
  }
}

/** The values a container holds; null for a value that holds none. */
function childrenOf(value: PickleValue): PickleValue[] | null {
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return null
  if (Array.isArray(value)) return value
  if (value instanceof Map) return [...value.keys(), ...value.values()]
  if (value instanceof Set) return [...value]
  if ('tuple' in value) return value.tuple
  if ('object' in value) return [value.object.class, value.object.args, value.object.state]
  return null
}

/**
 * Throws `depth` when containers are nested deeper than `maxDepth` along some path, or when a container
 * holds itself (a pickle can: the memo gives back a list that is still being filled). The walk keeps its
 * own stack, so the depth it refuses cannot overflow the call stack, and it visits a value shared by
 * many parents once.
 */
function assertDepth(root: PickleValue, maxDepth: number): void {
  /** Containers on the way down, with how many of their values are done and the tallest one so far. */
  interface Frame {
    node: PickleValue
    children: PickleValue[]
    next: number
    height: number
  }
  const heights = new Map<PickleValue, number>()
  const path = new Set<PickleValue>()
  const frames: Frame[] = []

  /** The height of `value` (containers from it down, itself included) when known without a visit. */
  function visit(value: PickleValue): number {
    const children = childrenOf(value)
    if (children === null) return 0
    const known = heights.get(value)
    if (known !== undefined) {
      if (frames.length + known > maxDepth)
        throw unreadable('depth', `containers nested more than ${maxDepth} deep`)
      return known
    }
    if (path.has(value)) throw unreadable('depth', 'a container that holds itself')
    if (frames.length >= maxDepth) throw unreadable('depth', `containers nested more than ${maxDepth} deep`)
    path.add(value)
    frames.push({ node: value, children, next: 0, height: 0 })
    return -1
  }

  const first = visit(root)
  if (first >= 0) return
  for (let frame = frames[frames.length - 1]; frame !== undefined; frame = frames[frames.length - 1]) {
    const child = frame.children[frame.next]
    if (frame.next < frame.children.length) {
      frame.next++
      const height = visit(child as PickleValue)
      if (height > frame.height) frame.height = height
      continue
    }
    frames.pop()
    path.delete(frame.node)
    heights.set(frame.node, frame.height + 1)
    const parent = frames[frames.length - 1]
    if (parent !== undefined && frame.height + 1 > parent.height) parent.height = frame.height + 1
  }
}

/**
 * The value `bytes` pickles (protocols 2 to 5). Throws MULTIDATA_UNREADABLE with `reason`: `opcode` for an
 * opcode outside the list or an operation the reader refuses, `truncated` for data that ends early or
 * does not add up (a stack with nothing to pop, a memo entry nobody wrote), `depth` for containers nested
 * deeper than `limits.maxDepth` (default 64) or that hold themselves, `size` for a pickle that creates
 * more than `limits.maxValues` values (default `MAX_VALUES`) or a container of more than
 * `limits.maxEntries` entries (default `MAX_ENTRIES`). What follows STOP is not read.
 */
export function unpickle(bytes: Uint8Array, limits: PickleLimits = {}): PickleValue {
  try {
    const machine = new Machine(bytes, limits.maxValues ?? MAX_VALUES, limits.maxEntries ?? MAX_ENTRIES)
    const value = machine.run()
    assertDepth(value, limits.maxDepth ?? DEFAULT_MAX_DEPTH)
    return value
  } catch (error) {
    // A limit of the engine (a Map or an array that cannot grow) that the budgets missed: still a file too big.
    if (error instanceof RangeError) throw tooBig(`past a limit of the engine: ${error.message}`)
    throw error
  }
}

// Reads player YAML files as Archipelago does (spec §3.10, research brief §1.9): bytes decoded as
// `utf-8-sig`, text parsed with PyYAML's SafeLoader through UniqueKeyLoader (Utils.py:247-263). That is
// YAML 1.1 with PyYAML's own implicit types, which the yaml package's 'yaml-1.1' schema only
// approximates (`y` is a boolean there, `08` an int, `1e5` a float: strings for PyYAML). The tags below
// are PyYAML's resolvers (yaml/resolver.py); the writer stringifies with them too, so what it writes
// PyYAML reads back with the same types.
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  Scalar,
  visit,
  type Document,
  type DocumentOptions,
  type Node,
  type ParseOptions,
  type ScalarTag,
  type SchemaOptions,
  type Tags,
  type ToStringOptions,
} from 'yaml'
import { mapTag, seqTag, stringifyString, stringTag } from 'yaml/util'
import type { Issue } from '@shared/types'

/**
 * A YAML float holding an integer (`5.0`). JavaScript has one number type, but Archipelago does not:
 * a Range refuses `5.0`. loadYaml11 gives these as YamlFloat (plain numbers otherwise); JSON sees the
 * number.
 */
export class YamlFloat {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value
  }
  toJSON(): number {
    return this.value
  }
}

const TAG = 'tag:yaml.org,2002:'
const FLOAT_TAG = `${TAG}float`
const INT_TAG = `${TAG}int`

// --- PyYAML's implicit resolvers -------------------------------------------------------------------

const PY_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/
const PY_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/
const PY_NULL = /^(?:~|null|Null|NULL|)$/
const PY_INT_BIN = /^[-+]?0b[01_]+$/
const PY_INT_OCT = /^[-+]?0[0-7_]+$/
const PY_INT_DEC = /^[-+]?(?:0|[1-9][0-9_]*)$/
const PY_INT_HEX = /^[-+]?0x[0-9a-fA-F_]+$/
const PY_INT_60 = /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/
const PY_FLOAT = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$/
const PY_FLOAT_60 = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/
const PY_FLOAT_SPECIAL = /^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/
const PY_TIMESTAMP =
  /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/
/** `=` (tag:yaml.org,2002:value) and `<<` (merge): resolved by PyYAML, constructed by nothing in SafeLoader. */
const PY_UNCONSTRUCTIBLE = /^(?:=|<<)$/

/** Every plain scalar PyYAML would not read as a string. */
const PY_NON_STRING: readonly RegExp[] = [
  PY_TRUE,
  PY_FALSE,
  PY_NULL,
  PY_INT_BIN,
  PY_INT_OCT,
  PY_INT_DEC,
  PY_INT_HEX,
  PY_INT_60,
  PY_FLOAT,
  PY_FLOAT_60,
  PY_FLOAT_SPECIAL,
  PY_TIMESTAMP,
  PY_UNCONSTRUCTIBLE,
]

const FLOAT_TESTS = [PY_FLOAT, PY_FLOAT_60, PY_FLOAT_SPECIAL]

const digits = (s: string): string => s.replace(/_/g, '')

function signed(s: string): { sign: number; body: string } {
  const sign = s.startsWith('-') ? -1 : 1
  return { sign, body: /^[-+]/.test(s) ? s.slice(1) : s }
}

/** `1:20` → 80, `1:20.5` → 80.5 (base 60, as PyYAML's construct_yaml_int/float). */
function sexagesimal(s: string): number {
  const { sign, body } = signed(digits(s))
  return sign * body.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function radix(s: string, prefix: number, base: number): number {
  const { sign, body } = signed(digits(s))
  return sign * (body.length > prefix ? parseInt(body.slice(prefix), base) : 0)
}

function floatValue(s: string): number {
  const text = digits(s)
  if (/nan$/i.test(text)) return NaN
  if (/inf$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity
  return Number(text.replace(/\.(?=[eE]|$)/, '.0'))
}

/** A number as PyYAML writes it: a float always has a dot, an int never has an exponent. */
function numberText(value: unknown, float: boolean): string {
  if (typeof value === 'bigint') return value.toString()
  const n = Number(value)
  if (Number.isNaN(n)) return '.nan'
  if (!Number.isFinite(n)) return n < 0 ? '-.inf' : '.inf'
  if (!float) return Number.isSafeInteger(n) ? String(n) : BigInt(n).toString()
  const text = String(n)
  if (/[.e]/i.test(text)) return text.replace(/^(-?\d+)e/i, '$1.0e').replace(/e(\d)/i, 'e+$1')
  return `${text}.0`
}

/** A parsed scalar written as it was read, when that text still means its value; else `fallback`. */
function sourceOr(
  item: Scalar,
  tests: readonly RegExp[],
  read: (s: string) => unknown,
  fallback: string,
): string {
  const { source } = item
  if (typeof source === 'string' && tests.some((re) => re.test(source))) {
    const again = read(source)
    if (Object.is(again, item.value)) return source
  }
  return fallback
}

const nullTag: ScalarTag = {
  identify: (value) => value === null || value === undefined,
  default: true,
  tag: `${TAG}null`,
  test: PY_NULL,
  resolve: () => new Scalar(null),
  stringify: (item) => sourceOr(item, [PY_NULL], () => null, 'null'),
}

function boolTag(value: boolean, test: RegExp): ScalarTag {
  return {
    identify: (v) => v === value,
    default: true,
    tag: `${TAG}bool`,
    test,
    resolve: () => new Scalar(value),
    stringify: (item) => sourceOr(item, [test], () => value, String(value)),
  }
}

const readInt = (s: string): number => {
  if (PY_INT_60.test(s)) return sexagesimal(s)
  if (PY_INT_BIN.test(s)) return radix(s, 2, 2)
  if (PY_INT_HEX.test(s)) return radix(s, 2, 16)
  if (PY_INT_OCT.test(s)) return radix(s, 1, 8)
  return Number(digits(s))
}
const INT_TESTS = [PY_INT_BIN, PY_INT_OCT, PY_INT_DEC, PY_INT_HEX, PY_INT_60]

const readFloat = (s: string): number => (PY_FLOAT_60.test(s) ? sexagesimal(s) : floatValue(s))

const readNumber = (s: string): number => (INT_TESTS.some((re) => re.test(s)) ? readInt(s) : readFloat(s))

/**
 * A parsed number keeps its spelling (`0755`, `1.0`, `1:20`): the yaml package stringifies a parsed
 * `1.0` with an int tag (same value), so the spelling is what keeps it a float.
 */
const numberStringify =
  (float: boolean) =>
  (item: Scalar): string =>
    sourceOr(item, [...INT_TESTS, ...FLOAT_TESTS], readNumber, numberText(item.value, float))

function intTag(test: RegExp, format?: string): ScalarTag {
  return {
    identify: (v) => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v)),
    default: true,
    tag: INT_TAG,
    ...(format ? { format } : {}),
    test,
    resolve: (s) => readInt(s),
    stringify: numberStringify(false),
  }
}

function floatTag(test: RegExp, format?: string): ScalarTag {
  return {
    identify: (v) => typeof v === 'number',
    default: true,
    tag: FLOAT_TAG,
    ...(format ? { format } : {}),
    test,
    resolve: (s) => readFloat(s),
    stringify: numberStringify(true),
  }
}

/** PyYAML builds a datetime; it is not a string, which is what the validation needs to know. */
const timestampTag: ScalarTag = {
  identify: (v) => v instanceof Date,
  default: true,
  tag: `${TAG}timestamp`,
  test: PY_TIMESTAMP,
  resolve: (s) => {
    const date = new Date(s.replace(/[ \t]+(?=\d)/, 'T').replace(/[ \t]+/g, ''))
    return Number.isNaN(date.getTime()) ? new Date(0) : date
  },
  stringify: (item) => {
    const { source, value } = item
    if (typeof source === 'string' && PY_TIMESTAMP.test(source)) return source
    return value instanceof Date ? value.toISOString() : String(value)
  },
}

/** `=` and `<<`: SafeConstructor has no constructor for them, so UniqueKeyLoader fails on them. */
const unconstructibleTag: ScalarTag = {
  default: true,
  tag: 'tag:archipelagoat,2026:pyyaml-unconstructible',
  test: PY_UNCONSTRUCTIBLE,
  resolve: (s, onError) => {
    onError(`PyYAML SafeLoader cannot construct the plain scalar ${s}`)
    return s
  },
}

// --- strings, written so that PyYAML reads them back unchanged --------------------------------------

/**
 * What PyYAML's reader refuses raw (non-printable characters, lone surrogates) or reads as a line
 * break (CR, NEL, LS, PS): written as escapes.
 */
function needsEscape(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    [0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff].includes(code)
  )
}

const hasEscapes = (s: string): boolean => Array.from(s).some(needsEscape)
/** The yaml package's rules for a plain scalar (stringifyString.js), plus document markers. */
const PLAIN_FORBIDDEN =
  /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$|^(?:---|\.\.\.)/

/** True when `s` can be written as a plain scalar that PyYAML reads as this very string. */
export function isPlainSafe(s: string, inFlow = false): boolean {
  return (
    s !== '' &&
    // PyYAML ends a plain scalar at a tab, then fails on it.
    !/[\n\t]/.test(s) &&
    !hasEscapes(s) &&
    !PLAIN_FORBIDDEN.test(s) &&
    !(inFlow && /[[\]{},]|^[?:]/.test(s)) &&
    !PY_NON_STRING.some((re) => re.test(s))
  )
}

const ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A double-quoted scalar that PyYAML reads back exactly (only escapes it knows). */
export function pyDoubleQuoted(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    const known = ESCAPES[ch]
    if (known) out += known
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (needsEscape(ch)) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const stringTagPy: ScalarTag = {
  ...stringTag,
  stringify(item, ctx, onComment, onChompKeep) {
    const value = String(item.value)
    const quoted = item.type === Scalar.QUOTE_DOUBLE || item.type === Scalar.QUOTE_SINGLE
    if (!quoted && isPlainSafe(value, Boolean(ctx.inFlow))) return value
    // A multi-line string without anything to escape: the yaml package picks a block scalar.
    if (!quoted && value.includes('\n') && !hasEscapes(value) && !ctx.implicitKey && !ctx.inFlow) {
      return stringifyString(item, { ...ctx, actualString: true }, onComment, onChompKeep)
    }
    return pyDoubleQuoted(value)
  },
}

/** The explicit-only tags of YAML 1.1 that SafeLoader also builds. */
const EXPLICIT_TAGS = new Set([`${TAG}binary`, `${TAG}omap`, `${TAG}pairs`, `${TAG}set`])

function pyyamlTags(base: Tags): Tags {
  const explicit = base.filter((tag) => typeof tag !== 'string' && EXPLICIT_TAGS.has(tag.tag))
  return [
    mapTag,
    seqTag,
    stringTagPy,
    nullTag,
    boolTag(true, PY_TRUE),
    boolTag(false, PY_FALSE),
    intTag(PY_INT_BIN, 'BIN'),
    intTag(PY_INT_OCT, 'OCT'),
    intTag(PY_INT_DEC),
    intTag(PY_INT_HEX, 'HEX'),
    intTag(PY_INT_60, 'TIME'),
    floatTag(PY_FLOAT_SPECIAL),
    floatTag(PY_FLOAT),
    floatTag(PY_FLOAT_60, 'TIME'),
    timestampTag,
    unconstructibleTag,
    ...explicit,
  ]
}

/** Parsing and creating documents the way PyYAML reads them (merge keys are not constructed). */
export const PYYAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version: '1.1',
  customTags: pyyamlTags,
  merge: false,
  uniqueKeys: true,
  logLevel: 'silent',
}

/** How the writer lays out text: no folding, 2 spaces. */
export const WRITE_OPTIONS: ToStringOptions = { lineWidth: 0, indent: 2 }

// --- decoding --------------------------------------------------------------------------------------

/**
 * The text of a player file. Archipelago reads `utf-8-sig`; files saved by other tools may be UTF-16
 * (with a BOM) or Windows-1252, read as such with an `encoding-fallback` warning for the latter.
 */
export function decodeYamlBytes(buf: Uint8Array): { text: string; issues: Issue[] } {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf), issues: [] }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf), issues: [] }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), issues: [] }
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(buf),
      issues: [{ severity: 'warning', code: 'encoding-fallback' }],
    }
  }
}

// --- parsing ---------------------------------------------------------------------------------------

export interface ParsedYaml {
  /** Every document, an empty one included (its contents are null). */
  docs: Document.Parsed[]
  issues: Issue[]
  lines: LineCounter
}

/** str(key) in Python, for the `key` / `+key` rule of UniqueKeyLoader. */
function pyStr(value: unknown): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value === null) return 'None'
  return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value)
}

function at(lines: LineCounter, offset: number | undefined): { line: number; column: number } | null {
  if (offset === undefined) return null
  const pos = lines.linePos(offset)
  return { line: pos.line, column: pos.col }
}

/** `key` and `+key` in one mapping raise KeyError in UniqueKeyLoader (Utils.py:252-255). */
function mergeDuplicates(doc: Document.Parsed, lines: LineCounter): Issue[] {
  const issues: Issue[] = []
  visit(doc, {
    Map(_, map) {
      const seen = new Set<string>()
      for (const pair of map.items) {
        if (!isScalar(pair.key)) continue
        const key = pyStr(pair.key.value)
        const clash = (key.startsWith('+') && seen.has(key.slice(1))) || seen.has(`+${key}`)
        seen.add(key)
        if (!clash) continue
        const pos = at(lines, pair.key.range?.[0])
        issues.push({
          severity: 'error',
          code: 'duplicate-key',
          params: { key: key.replace(/^\+/, ''), ...pos },
        })
      }
    },
  })
  return issues
}

/** Nodes a document may hold once its aliases are expanded: a player file has a few thousand. */
const EXPANDED_NODES_MAX = 100_000

/**
 * False when expanding the aliases would never end (an alias inside what it names) or would blow up
 * (an alias bomb): the validation and the writer expand them.
 */
function aliasesBounded(doc: Document.Parsed): boolean {
  let budget = EXPANDED_NODES_MAX
  const open = new Set<unknown>()
  const walk = (node: unknown): boolean => {
    if (--budget < 0) return false
    if (isAlias(node)) {
      const target = node.resolve(doc)
      return !open.has(target) && walk(target)
    }
    if (!isMap(node) && !isSeq(node)) return true
    open.add(node)
    const items: unknown[] = isMap(node) ? node.items.flatMap((pair) => [pair.key, pair.value]) : node.items
    const ok = items.every(walk)
    open.delete(node)
    return ok
  }
  return walk(doc.contents)
}

/** The key a DUPLICATE_KEY error points at, read from the text. */
function keyAt(text: string, offset: number): string {
  const rest = text.slice(offset)
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:\n]*?))\s*:/.exec(rest)
  return (match?.[1] ?? match?.[2]?.replace(/''/g, "'") ?? match?.[3] ?? '').trim()
}

/** Every document of `text` as PyYAML would build them, with the problems that make PyYAML fail. */
export function parseYamlDocuments(text: string): ParsedYaml {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = new LineCounter()
  const parsed = parseAllDocuments(source, { ...PYYAML_OPTIONS, lineCounter: lines })
  const docs = (Array.isArray(parsed) ? parsed : []) as Document.Parsed[]
  const issues: Issue[] = []
  for (const doc of docs) {
    const problems = [
      ...doc.errors,
      // An unknown tag is a warning for the yaml package; SafeLoader fails on it.
      ...doc.warnings.filter((warning) => warning.code === 'TAG_RESOLVE_FAILED'),
    ]
    for (const error of problems) {
      const pos = error.linePos?.[0]
      const where: Record<string, number> = pos ? { line: pos.line, column: pos.col } : {}
      if (error.code === 'DUPLICATE_KEY') {
        issues.push({
          severity: 'error',
          code: 'duplicate-key',
          params: { key: keyAt(source, error.pos[0]), ...where },
        })
      } else {
        issues.push({ severity: 'error', code: 'yaml-syntax', params: where })
      }
    }
    if (doc.errors.length > 0) continue
    if (!aliasesBounded(doc))
      issues.push({ severity: 'error', code: 'yaml-syntax', params: { reason: 'aliases' } })
    else issues.push(...mergeDuplicates(doc, lines))
  }
  return { docs, issues, lines }
}

const isFloatNode = (node: Scalar): boolean =>
  node.tag === FLOAT_TAG ||
  (!node.tag &&
    node.type === Scalar.PLAIN &&
    typeof node.source === 'string' &&
    FLOAT_TESTS.some((re) => re.test(node.source as string)))

/** True for a scalar PyYAML reads as a float that JavaScript holds as an integer (`5.0`). */
export function isIntegralFloat(node: Scalar): boolean {
  return typeof node.value === 'number' && Number.isInteger(node.value) && isFloatNode(node)
}

/** Plain data for the validation: keys as strings, sets as lists, YamlFloat for `5.0`. */
function toData(node: Node | null | undefined, doc: Document.Parsed): unknown {
  if (node === null || node === undefined) return null
  if (isScalar(node)) return isIntegralFloat(node) ? new YamlFloat(node.value as number) : node.value
  if (isMap(node)) {
    if (node.tag === `${TAG}set`) return node.items.map((pair) => toData(pair.key as Node, doc))
    const out: Record<string, unknown> = {}
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : JSON.stringify(toData(pair.key as Node, doc))
      Object.defineProperty(out, key, {
        value: toData(pair.value as Node, doc),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  if (isSeq(node)) return node.items.map((item) => toData(item as Node, doc))
  if (isAlias(node)) return toData(node.resolve(doc), doc)
  return null
}

/**
 * Every document of `text` as plain data (an empty document is null). Any problem PyYAML would fail
 * on (syntax, duplicate key, unknown tag) gives no documents: Archipelago refuses the whole file.
 */
export function loadYaml11(text: string): { docs: unknown[]; issues: Issue[] } {
  const { docs, issues } = parseYamlDocuments(text)
  if (issues.length > 0) return { docs: [], issues }
  return { docs: docs.map((doc) => toData(doc.contents, doc)), issues: [] }
}

// Player YAML ⇄ EditorDoc (spec §3.10). The writer's output is read back identically by Archipelago's
// UniqueKeyLoader: PyYAML's own implicit types decide what gets quoted (load.ts), ranges are integers,
// an empty game section is `{}`, `requires.version` is quoted, a negative `random-range` is never
// written (Archipelago mis-reads it), and the text is UTF-8 without BOM.
//
// parsePlayerYaml → renderPlayerYaml keeps every value with its YAML type: what plain data cannot hold
// exactly (a boolean key, a `5.0`, a set, a date) is kept as `raw` YAML. Comments outside of those
// are not kept, and the section of the doc's game always comes back: missing or `Game:` (null, which
// crashes the generation), it is written as `{}`.
import { Document, isAlias, isMap, isScalar, isSeq, Pair, Scalar, visit, YAMLMap, type Node } from 'yaml'
import type { EditorDoc, GameSchema, Issue, OptionSchema, OptionValue } from '@shared/types'
import {
  isIntegralFloat,
  isPlainSafe,
  parseYamlDocuments,
  pyDoubleQuoted,
  PYYAML_OPTIONS,
  WRITE_OPTIONS,
} from './load'

/** `s` as a YAML scalar PyYAML reads as this very string: plain when it can be, else double-quoted. */
export function quoteIfAmbiguous(s: string): string {
  return isPlainSafe(s) ? s : pyDoubleQuoted(s)
}

/** The root keys an EditorDoc holds in its own fields when they are non-empty strings. */
const CORE_KEYS = ['name', 'description', 'game'] as const
type CoreKey = (typeof CORE_KEYS)[number]
const isCoreKey = (key: string): key is CoreKey => (CORE_KEYS as readonly string[]).includes(key)

const CORE_SCALAR_TAGS = new Set(['str', 'int', 'float', 'bool', 'null'].map((t) => `tag:yaml.org,2002:${t}`))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringKey = (node: unknown): node is Scalar<string> =>
  isScalar(node) && typeof node.value === 'string'

const isNull = (node: unknown): boolean => node === null || (isScalar(node) && node.value === null)

// --- parsing ---------------------------------------------------------------------------------------

/** Aliases become copies of what they name, anchors go: each value then stands on its own. */
function materialize(target: Document.Parsed | Node, doc: Document.Parsed): void {
  // The anchors are still there while the aliases are resolved.
  visit(target, {
    Alias(_, alias) {
      return (alias.resolve(doc)?.clone() as Node | undefined) ?? new Scalar(null)
    },
  })
  visit(target, {
    Node(_, node) {
      if (!isAlias(node)) delete node.anchor
    },
  })
}

/** True when plain data holds the node exactly: string keys, no tags, no `5.0`, no date. */
function isLossless(node: unknown): boolean {
  if (node === null) return true
  if (isScalar(node)) {
    if (node.tag && !CORE_SCALAR_TAGS.has(node.tag)) return false
    const { value } = node
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value !== 'number' || !Number.isFinite(value) || isIntegralFloat(node)) return false
    return !Number.isInteger(value) || Number.isSafeInteger(value)
  }
  if (isMap(node))
    return !node.tag && node.items.every((pair) => isStringKey(pair.key) && isLossless(pair.value))
  if (isSeq(node)) return !node.tag && node.items.every(isLossless)
  return false
}

/** Text keys, number values: the weights of a weighted option. */
function isWeights(node: unknown): node is YAMLMap<Scalar<string>, Scalar<number>> {
  return (
    isMap(node) &&
    !node.tag &&
    node.items.length > 0 &&
    node.items.every(
      (pair) =>
        isStringKey(pair.key) &&
        isScalar(pair.value) &&
        typeof pair.value.value === 'number' &&
        isLossless(pair.value),
    )
  )
}

/** The node as YAML text, in block style, for the raw editor. */
function nodeText(node: Node): string {
  visit(node, {
    Collection(_, collection) {
      collection.flow = false
    },
  })
  const out = new Document(null, PYYAML_OPTIONS)
  out.contents = node
  return out.toString(WRITE_OPTIONS).replace(/\n$/, '')
}

function optionValueOf(node: Node | null, doc: Document.Parsed, weighted = false): OptionValue {
  if (node === null) return { mode: 'value', value: null }
  if (weighted && isWeights(node)) {
    return {
      mode: 'weighted',
      weights: Object.fromEntries(node.items.map((p) => [p.key.value, (p.value as Scalar<number>).value])),
    }
  }
  if (isLossless(node)) return { mode: 'value', value: node.toJS(doc) }
  return { mode: 'raw', yaml: nodeText(node) }
}

/** `requires.version` when it is a non-empty string, and the rest of `requires` (undefined: nothing). */
function splitRequires(node: Node | null): { version: string | null; rest: Node | null | undefined } {
  if (isMap(node)) {
    const version = node.items.find((pair) => isStringKey(pair.key) && pair.key.value === 'version')?.value
    if (isScalar(version) && typeof version.value === 'string' && version.value !== '') {
      const rest = node.clone() as YAMLMap
      rest.items = rest.items.filter((pair) => !(isStringKey(pair.key) && pair.key.value === 'version'))
      return { version: version.value, rest: rest.items.length > 0 ? rest : undefined }
    }
  }
  return { version: null, rest: node }
}

/** The EditorDoc of one document; null when one cannot hold it exactly (Archipelago refuses it too). */
function toEditorDoc(doc: Document.Parsed): EditorDoc | null {
  const root = doc.contents
  if (!isMap(root) || !root.items.every((pair) => isStringKey(pair.key))) return null
  const text = (key: CoreKey): string => {
    const node = root.get(key, true)
    return isScalar(node) && typeof node.value === 'string' ? node.value : ''
  }
  const core = { name: text('name'), description: text('description'), game: text('game') }
  let requiresVersion: string | null = null
  const options: [string, OptionValue][] = []
  const extra: [string, OptionValue][] = []

  for (const pair of root.items) {
    const key = (pair.key as Scalar<string>).value
    const node = (pair.value ?? null) as Node | null
    if (isCoreKey(key)) {
      if (core[key] === '') extra.push([key, optionValueOf(node, doc)])
    } else if (key === 'requires') {
      const { version, rest } = splitRequires(node)
      requiresVersion = version
      if (rest !== undefined) extra.push([key, optionValueOf(rest, doc)])
    } else if (core.game !== '' && key === core.game) {
      // `Game:` left empty crashes the generation: it is written back as `{}`.
      if (isNull(node)) continue
      if (!isMap(node) || !node.items.every((option) => isStringKey(option.key))) return null
      for (const option of node.items) {
        options.push([
          (option.key as Scalar<string>).value,
          optionValueOf((option.value ?? null) as Node | null, doc, true),
        ])
      }
    } else {
      extra.push([key, optionValueOf(node, doc)])
    }
  }
  return {
    ...core,
    requiresVersion,
    options: Object.fromEntries(options),
    extraRoot: Object.fromEntries(extra),
  }
}

/**
 * The EditorDocs of a player file, one per non-empty document, in file order (the order of
 * PlayerDoc.index). A file one cannot read back exactly gives no documents and the issue why.
 */
export function parsePlayerYaml(text: string): { docs: EditorDoc[]; issues: Issue[] } {
  const { docs, issues, lines } = parseYamlDocuments(text)
  if (issues.length > 0) return { docs: [], issues }
  const editors: EditorDoc[] = []
  for (const [index, doc] of docs.entries()) {
    if (isNull(doc.contents)) continue
    materialize(doc, doc)
    const editor = toEditorDoc(doc)
    if (!editor) {
      const offset = doc.contents?.range?.[0]
      const line: Record<string, number> = offset === undefined ? {} : { line: lines.linePos(offset).line }
      return {
        docs: [],
        issues: [{ severity: 'error', code: 'yaml-syntax', params: { doc: index + 1, ...line } }],
      }
    }
    editors.push(editor)
  }
  return { docs: editors, issues: [] }
}

// --- rendering -------------------------------------------------------------------------------------

function isOptionValue(value: unknown): value is OptionValue {
  if (!isRecord(value)) return false
  if (value.mode === 'value') return 'value' in value
  if (value.mode === 'weighted') return isRecord(value.weights)
  return value.mode === 'raw' && typeof value.yaml === 'string'
}

const RANDOM_RANGE = /^random-range-(?:(low|middle|high)-)?(-?\d+)-(-?\d+)$/

/**
 * What to write instead of a random range with a negative bound, which Archipelago reads wrong
 * (`random-range--60-60` always gives 60): the plain random of the whole range, or weights on each
 * value giving the same odds. Null when the text needs no change, or is out of the range (left for
 * the validation to report).
 */
function rewriteRandomRange(
  text: string,
  range: { min: number; max: number } | null,
): { replace: string } | { weights: Map<number, number> } | null {
  const match = RANDOM_RANGE.exec(text.trim().toLowerCase())
  if (!match || !range) return null
  const [a, b] = [Number(match[2]), Number(match[3])]
  if (a >= 0 && b >= 0) return null
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)]
  if (lo < range.min || hi > range.max) return null
  const variant = match[1]
  if (lo === range.min && hi === range.max) return { replace: variant ? `random-${variant}` : 'random' }
  const weights = new Map<number, number>()
  for (let i = lo; i <= hi; i++) {
    const fromLow = i - lo + 1
    const fromHigh = hi - i + 1
    weights.set(
      i,
      variant === 'low'
        ? fromHigh
        : variant === 'high'
          ? fromLow
          : variant === 'middle'
            ? Math.min(fromLow, fromHigh)
            : 1,
    )
  }
  return { weights }
}

/** The weights of a range: numbers as integer keys, negative random ranges rewritten. */
function rangeWeights(
  weights: Record<string, number>,
  range: { min: number; max: number } | null,
): Map<string | number, number> {
  const entries = Object.entries(weights).map(([key, weight]) => ({
    key,
    weight,
    rewrite: rewriteRandomRange(key, range),
  }))
  const sumOf = (map: Map<number, number>): number => [...map.values()].reduce((a, b) => a + b, 0)
  // Each expansion is scaled to its own weight; everything else by the sum of every expansion.
  const scale = entries.reduce(
    (product, e) =>
      e.weight !== 0 && e.rewrite && 'weights' in e.rewrite ? product * sumOf(e.rewrite.weights) : product,
    1,
  )
  const out = new Map<string | number, number>()
  const add = (key: string | number, weight: number): void => {
    out.set(key, (out.get(key) ?? 0) + weight)
  }
  for (const { key, weight, rewrite } of entries) {
    if (!rewrite) add(/^[-+]?\d+(?:\.\d+)?$/.test(key.trim()) ? Math.round(Number(key)) : key, weight * scale)
    else if (weight === 0) continue
    else if ('replace' in rewrite) add(rewrite.replace, weight * scale)
    else {
      const own = sumOf(rewrite.weights)
      for (const [value, odds] of rewrite.weights) add(value, (weight * odds * scale) / own)
    }
  }
  return out
}

function weightsNode(weights: Map<string | number, number> | Record<string, number>): YAMLMap {
  const map = new YAMLMap()
  const entries = weights instanceof Map ? [...weights] : Object.entries(weights)
  for (const [key, weight] of entries) map.add(new Pair(new Scalar(key), new Scalar(weight)))
  return map
}

export interface RenderResult {
  text: string
  /** `yaml-syntax` (or `duplicate-key`) for a raw value that is not valid YAML; that value is left out. */
  issues: Issue[]
}

/** The YAML of one document, and the problems of its raw values. */
export function renderPlayerDoc(doc: EditorDoc, schema?: GameSchema): RenderResult {
  const out = new Document(null, PYYAML_OPTIONS)
  const issues: Issue[] = []

  function rawNode(yaml: string, path: string): Node | undefined {
    if (yaml.trim() === '') return undefined
    const parsed = parseYamlDocuments(yaml)
    const [first] = parsed.issues
    if (first) {
      issues.push({ ...first, path })
      return undefined
    }
    const docs = parsed.docs.filter((d) => d.contents !== null)
    if (docs.length > 1) issues.push({ severity: 'error', code: 'yaml-syntax', path })
    const [only] = docs
    if (!only || docs.length > 1) return undefined
    materialize(only, only)
    return only.contents as Node
  }

  function nodeOf(value: unknown, path: string): Node | undefined {
    if (!isOptionValue(value)) return value === undefined ? undefined : out.createNode(value)
    if (value.mode === 'raw') return rawNode(value.yaml, path)
    if (value.mode === 'weighted') return weightsNode(value.weights)
    return value.value === undefined ? undefined : out.createNode(value.value)
  }

  function optionNode(value: OptionValue, path: string, option: OptionSchema | undefined): Node | undefined {
    if (!isOptionValue(value) || !option || (option.kind !== 'range' && option.kind !== 'named-range')) {
      return nodeOf(value, path)
    }
    if (value.mode === 'weighted') return weightsNode(rangeWeights(value.weights, option.range))
    if (value.mode === 'value' && typeof value.value === 'number' && Number.isFinite(value.value)) {
      return out.createNode(Math.round(value.value))
    }
    if (value.mode === 'value' && typeof value.value === 'string') {
      const rewrite = rewriteRandomRange(value.value, option.range)
      if (rewrite) return 'replace' in rewrite ? new Scalar(rewrite.replace) : weightsNode(rewrite.weights)
    }
    return nodeOf(value, path)
  }

  const root = new YAMLMap()
  const put = (map: YAMLMap, key: string, node: Node | undefined): void => {
    if (node !== undefined) map.add(new Pair(new Scalar(key), node))
  }
  const extra = doc.extraRoot
  const extraNode = (key: string): Node | undefined =>
    Object.hasOwn(extra, key) ? nodeOf(extra[key], key) : undefined

  for (const key of CORE_KEYS) put(root, key, doc[key] !== '' ? new Scalar(doc[key]) : extraNode(key))

  const requires = extraNode('requires')
  if (doc.requiresVersion === null) put(root, 'requires', requires)
  else {
    const version = new Scalar(doc.requiresVersion)
    version.type = Scalar.QUOTE_DOUBLE
    const map = new YAMLMap()
    map.add(new Pair(new Scalar('version'), version))
    if (isMap(requires)) {
      for (const pair of requires.items)
        if (!(isStringKey(pair.key) && pair.key.value === 'version')) map.add(pair)
    }
    put(root, 'requires', map)
  }

  for (const key of Object.keys(extra)) {
    if (isCoreKey(key) || key === 'requires' || (doc.game !== '' && key === doc.game)) continue
    put(root, key, extraNode(key))
  }

  if (doc.game !== '') {
    const known = schema?.game === doc.game ? schema.groups.flatMap((group) => group.options) : []
    const byKey = new Map(known.map((option) => [option.key, option]))
    const section = new YAMLMap()
    for (const [key, value] of Object.entries(doc.options)) {
      put(section, key, optionNode(value, `${doc.game}.${key}`, byKey.get(key)))
    }
    put(root, doc.game, section)
  }

  out.contents = root
  return { text: out.toString(WRITE_OPTIONS), issues }
}

/** The YAML text of one document (UTF-8 without BOM once encoded). */
export function renderPlayerYaml(doc: EditorDoc, schema?: GameSchema): string {
  return renderPlayerDoc(doc, schema).text
}

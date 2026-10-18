// Balancing proposals (spec §3.5). A player whose checks stray from the session's target gets up to
// three proposals, each measured. The options whose name or kind tells the size of the game
// (`sizeCandidates`) are turned one at a time toward fewer or more checks (`variantsToward`), twelve
// of them measured at most; those that move the count the right way are combined greedily, three
// changes at most, and the combination is measured as well. An option written the template way
// (weights on a single choice) counts as that choice; real dice are never touched. Nothing is written
// before a proposal is applied, and then only its options, in that one document of the file:
// comments, order and the other players stay as they were. A proposal shows the diff apply writes,
// and is kept in memory for an hour.
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, type Document, type Node, type Pair, type YAMLMap } from 'yaml'
import { measuredCounts, targetOf } from '@shared/checks'
import { TOGGLE_OFF, TOGGLE_ON } from '@shared/data/ap-constants'
import { AppError, type AppErrorData } from '@shared/errors'
import { setOptionValue } from '@shared/studio-model'
import type {
  BalanceProposal,
  BalanceTarget,
  EditorDoc,
  GameSchema,
  OptionChange,
  OptionSchema,
  OptionValue,
  Session,
} from '@shared/types'
import type { Templates } from '../ap/templates'
import type { CoreContext } from '../context'
import type { SessionStore } from '../sessions/store'
import type { TaskHandle } from '../tasks'
import { loadYaml11, parseYamlDocuments } from '../yaml/load'
import { parsePlayerYaml, quoteIfAmbiguous, renderPlayerYaml } from '../yaml/writer'
import { soleChoice, type Measurer } from './measure'

/** Single-option variants measured per player. */
const MAX_SINGLES = 12
/** Changes a combination holds at most. */
const MAX_CHANGES = 3
const MAX_PROPOSALS = 3
/** How long a proposal can be applied. */
const PROPOSAL_TTL_MS = 60 * 60 * 1000

type Direction = 'fewer' | 'more'

// --- the options that tell the size --------------------------------------------------------------------

/** The names of spec §3.5, on snake_case keys: `*sanity*`, `shuffle_*`, `randomize_*`, `*_count`… */
const SIZE_NAMES: readonly RegExp[] = [
  /sanity/,
  /^shuffle_/,
  /^randomize_/,
  /_count$/,
  /^number_of_/,
  /locations/,
  /checks/,
  /^goal$/,
  /^(?:include|exclude)_/,
]

/** The options every game has, which say nothing of its size: never touched. */
const COMMON_OPTIONS: ReadonlySet<string> = new Set([
  'progression_balancing',
  'accessibility',
  'local_items',
  'non_local_items',
  'start_inventory',
  'start_inventory_from_pool',
  'start_hints',
  'start_location_hints',
  'exclude_locations',
  'priority_locations',
  'item_links',
  'plando_items',
  'plando_connections',
  'plando_texts',
  'death_link',
])

/** The kinds a value can be stepped in: lists, sets, dicts and free text cannot. */
const STEPPABLE: ReadonlySet<OptionSchema['kind']> = new Set([
  'toggle',
  'choice',
  'text-choice',
  'range',
  'named-range',
])

const isRangeKind = (option: OptionSchema): boolean =>
  option.kind === 'range' || option.kind === 'named-range'

/** `RandomizeMaskShards` → `randomize_mask_shards`: worlds name their options either way. */
export function snakeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

/** True for an option every game has (its snake_case key), which says nothing of its size. */
export const isCommon = (key: string): boolean =>
  COMMON_OPTIONS.has(key) || key.startsWith('plando_') || key.startsWith('start_inventory')

/**
 * The option schema of `game`: CHECKS_NO_SCHEMA when neither the local templates nor the site have
 * one (Templates.getSchema's NOT_FOUND), so that nothing can be built from its options.
 */
export async function checkedSchema(
  templates: Pick<Templates, 'getSchema'>,
  game: string,
): Promise<GameSchema> {
  try {
    return await templates.getSchema(game)
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      throw new AppError(
        'CHECKS_NO_SCHEMA',
        { game },
        { cause: error, ...(error.detail === undefined ? {} : { detail: error.detail }) },
      )
    }
    throw error
  }
}

/**
 * The options of `schema` that may change the size of the game: those whose name says so first, in
 * the schema's order, then the other numeric ranges. Common options are left out, and so are the
 * options whose value cannot be stepped (lists, sets, dicts).
 */
export function sizeCandidates(schema: GameSchema): OptionSchema[] {
  const options = schema.groups
    .flatMap((group) => group.options)
    .filter((option) => STEPPABLE.has(option.kind) && !isCommon(snakeKey(option.key)))
  const named = options.filter((option) => SIZE_NAMES.some((name) => name.test(snakeKey(option.key))))
  return [...named, ...options.filter((option) => isRangeKind(option) && !named.includes(option))]
}

// --- one option toward fewer or more checks --------------------------------------------------------

/** On or off; null for `random` or anything else Archipelago would not read as one of them. */
function toggleState(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (TOGGLE_ON.has(text)) return true
  if (TOGGLE_OFF.has(text)) return false
  return null
}

/** Where `value` stands among the choices; -1 for a number (an option id) or a random pick. */
function choiceIndex(option: OptionSchema, value: unknown): number {
  let text: string
  if (typeof value === 'string') text = value
  // `off` / `on` written plain, which PyYAML reads as booleans.
  else if (typeof value === 'boolean') text = value ? 'on' : 'off'
  else return -1
  const lower = text.trim().toLowerCase()
  return option.choices.findIndex((choice) => choice.toLowerCase() === lower)
}

/** The number a range value stands for (a special name gives its own); null for random or text. */
function rangeNumber(option: OptionSchema, value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (Object.hasOwn(option.specialNames, text)) return option.specialNames[text] ?? null
  return /^[-+]?\d+$/.test(text) ? Number(text) : null
}

/**
 * The value that turns `option`, now at `current`, toward fewer or more checks: a toggle switched
 * (on for more, but off for an `exclude_*` toggle), the next or previous choice, the bound of a
 * range. Empty when it already is there, or when `current` is a random pick or unknown.
 */
export function variantsToward(option: OptionSchema, current: unknown, direction: Direction): unknown[] {
  const more = direction === 'more'
  switch (option.kind) {
    case 'toggle': {
      const state = toggleState(current)
      const wanted = snakeKey(option.key).startsWith('exclude_') ? !more : more
      return state === null || state === wanted ? [] : [wanted]
    }
    case 'choice':
    case 'text-choice': {
      const at = choiceIndex(option, current)
      const next = at === -1 ? undefined : option.choices[more ? at + 1 : at - 1]
      return next === undefined ? [] : [next]
    }
    case 'range':
    case 'named-range': {
      const now = rangeNumber(option, current)
      if (now === null || option.range === null) return []
      const bound = more ? option.range.max : option.range.min
      return (more ? now < bound : now > bound) ? [bound] : []
    }
    default:
      return []
  }
}

// --- proposals -------------------------------------------------------------------------------------------

/** Some changes and the checks a measure gave with them. */
interface Measured {
  changes: OptionChange[]
  checks: number
}

const withChanges = (doc: EditorDoc, changes: readonly OptionChange[]): EditorDoc =>
  changes.reduce((next, change) => setOptionValue(next, change.key, { mode: 'value', value: change.to }), doc)

/** A choice of weights as the value it names: `'true'` is on for a toggle, `'20'` is 20 for a range. */
function valueOfChoice(option: OptionSchema, choice: string): unknown {
  if (option.kind === 'toggle') return toggleState(choice) ?? choice
  return isRangeKind(option) && /^[-+]?\d+$/.test(choice.trim()) ? Number(choice) : choice
}

/**
 * The value the doc always gives `option`: its own, the default when it leaves the option out, or
 * the one choice its weights give (raw YAML too, where the choices are numbers). Null when the dice
 * pick it, which are the player's own: never changed.
 */
function fixedValue(option: OptionSchema, set: OptionValue | undefined): { value: unknown } | null {
  if (set === undefined) return { value: option.default }
  if (set.mode === 'value') return { value: set.value }
  const sole = soleChoice(set.mode === 'weighted' ? set.weights : loadYaml11(set.yaml).docs[0])
  return sole === null ? null : { value: valueOfChoice(option, sole.choice) }
}

/** Each size option of the doc turned toward `direction`, in the order of sizeCandidates. */
function singleChanges(schema: GameSchema, doc: EditorDoc, direction: Direction): OptionChange[] {
  return sizeCandidates(schema).flatMap((option) => {
    const fixed = fixedValue(
      option,
      Object.hasOwn(doc.options, option.key) ? doc.options[option.key] : undefined,
    )
    if (fixed === null) return []
    const from = fixed.value
    return variantsToward(option, from, direction).map((to) => ({ key: option.key, from, to }))
  })
}

/**
 * The changes that, added up, bring `current` closest to `target`: each step takes the one that
 * brings it closest, as long as it brings it closer, three at most.
 */
function greedy(useful: readonly Measured[], current: number, target: number): Measured[] {
  const chosen: Measured[] = []
  let expected = current
  while (chosen.length < MAX_CHANGES) {
    let best: Measured | null = null
    let closest = Math.abs(expected - target)
    for (const single of useful) {
      const distance = Math.abs(expected + single.checks - current - target)
      if (!chosen.includes(single) && distance < closest) {
        best = single
        closest = distance
      }
    }
    if (best === null) break
    chosen.push(best)
    expected += best.checks - current
  }
  return chosen
}

/** Every value once settled; then the first rejection, if any. */
async function settleAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises)
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}

/** The lines `after` changes from `before`, in the order of the text: `-` the old, `+` the new. */
function lineDiff(before: string, after: string): string {
  const whole = { a: before.split('\n'), b: after.split('\n') }
  // The lines both texts start and end with are no part of the diff: the table holds the rest.
  let head = 0
  while (head < whole.a.length && head < whole.b.length && whole.a[head] === whole.b[head]) head++
  let tail = 0
  while (
    tail < whole.a.length - head &&
    tail < whole.b.length - head &&
    whole.a[whole.a.length - 1 - tail] === whole.b[whole.b.length - 1 - tail]
  ) {
    tail++
  }
  const a = whole.a.slice(head, whole.a.length - tail)
  const b = whole.b.slice(head, whole.b.length - tail)
  const width = b.length + 1
  // common(i, j): the length of the longest common subsequence of a[i..] and b[j..].
  const table = new Uint32Array((a.length + 1) * width)
  const common = (i: number, j: number): number => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? common(i + 1, j + 1) + 1 : Math.max(common(i + 1, j), common(i, j + 1))
    }
  }
  const lines: string[] = []
  let removed: string[] = []
  let added: string[] = []
  const flush = (): void => {
    lines.push(...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`))
    removed = []
    added = []
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      i++
      j++
    } else if (j < b.length && (i === a.length || common(i, j + 1) >= common(i + 1, j))) {
      added.push(b[j++] ?? '')
    } else {
      removed.push(a[i++] ?? '')
    }
  }
  flush()
  return lines.join('\n')
}

export interface ProposeInput {
  schema: GameSchema
  /** The player's document, as it is. */
  doc: EditorDoc
  /** Its checks now. */
  current: number
  /** The checks to aim at. */
  target: number
  /** The checks of a document; null when it could not be measured. */
  measure: (doc: EditorDoc) => Promise<number | null>
}

/**
 * Up to three proposals that bring `current` closer to `target`, the closest first: the greedy
 * combination of the single changes that move the count the right way (verified by a measure), and
 * the best of those single changes. Empty when none brings it closer. Rejects with the first
 * rejection of `measure` (a cancelled task).
 */
export async function proposeBalance(input: ProposeInput): Promise<BalanceProposal[]> {
  const { schema, doc, current, target, measure } = input
  if (current === target) return []
  const direction: Direction = current > target ? 'fewer' : 'more'
  const distance = (checks: number): number => Math.abs(checks - target)

  const singles = singleChanges(schema, doc, direction).slice(0, MAX_SINGLES)
  const counts = await settleAll(singles.map((change) => measure(withChanges(doc, [change]))))
  const useful: Measured[] = []
  singles.forEach((change, i) => {
    const checks = counts[i]
    if (checks === null || checks === undefined) return
    if (direction === 'fewer' ? checks < current : checks > current) {
      useful.push({ changes: [change], checks })
    }
  })

  const found = [...useful]
  const combination = greedy(useful, current, target).flatMap((single) => single.changes)
  if (combination.length > 1) {
    const checks = await measure(withChanges(doc, combination))
    if (checks !== null) found.push({ changes: combination, checks })
  }

  const before = renderPlayerYaml(doc, schema)
  return found
    .filter((proposal) => distance(proposal.checks) < distance(current))
    .sort((x, y) => distance(x.checks) - distance(y.checks) || x.changes.length - y.changes.length)
    .slice(0, MAX_PROPOSALS)
    .map(({ changes, checks }) => ({
      id: randomUUID(),
      changes,
      checks,
      diff: lineDiff(before, renderPlayerYaml(withChanges(doc, changes), schema)),
    }))
}

// --- writing a proposal in its file --------------------------------------------------------------------

/** Text put in place of `start`…`end` (an insertion when they are equal). */
interface Edit {
  start: number
  end: number
  text: string
}

/** The text as the YAML parser counts its offsets: no BOM, `\n` line ends. */
const plainText = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** The YAML of a value a proposal sets, as PyYAML reads it back; null for any other value. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === 'string' ? quoteIfAmbiguous(value) : null
}

/** The documents parsePlayerYaml leaves out, which PlayerDoc.index does not count. */
const isEmptyDoc = (doc: Document.Parsed): boolean =>
  doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `record` with `key` set to `value`, as a field of its own (whatever the key). */
const withField = (
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => ({
  ...record,
  [key]: value,
})

/** A scalar key as the loaded data spells it (`20` → `'20'`); null for any other key. */
const keyOf = (pair: Pair<unknown, unknown>): string | null =>
  isScalar(pair.key) ? String(pair.key.value) : null

/**
 * The edit that adds `lines` after the last entry of the block mapping `map`, at the indentation of
 * its first key; null when that cannot be told.
 */
function appendTo(source: string, map: YAMLMap<unknown, unknown>, lines: readonly string[]): Edit | null {
  const first = map.items[0]?.key
  const last = map.items.at(-1)
  const tail = (last?.value ?? last?.key) as Node | null | undefined
  if (!isScalar(first) || !first.range || !tail?.range) return null
  const indent = source.slice(source.lastIndexOf('\n', first.range[0] - 1) + 1, first.range[0])
  if (!/^ *$/.test(indent)) return null
  // After the line the last entry ends on (a block value ends with its own line break).
  const end = tail.range[1]
  const lineBreak = source[end - 1] === '\n' ? end - 1 : source.indexOf('\n', end)
  const at = lineBreak === -1 ? source.length : lineBreak + 1
  const text = lines.map((line) => `${indent}${line}\n`).join('')
  return { start: at, end: at, text: lineBreak === -1 ? `\n${text}` : text }
}

/**
 * The edits that move the weight of the one choice a block mapping of weights gives onto `to` (the
 * way Archipelago's templates write every option): the old choice gets 0, `to` gets the weight, added
 * after the last choice when it is not there. With the mapping as it then reads. Null for anything
 * else, real dice first: they are the player's own.
 */
function moveWeight(
  source: string,
  node: unknown,
  weights: unknown,
  to: unknown,
): { edits: Edit[]; value: Record<string, unknown> } | null {
  const sole = soleChoice(weights)
  const key = scalarText(to)
  if (sole === null || key === null || !isRecord(weights) || !isMap(node) || node.flow) return null
  const from = node.items.find((pair) => keyOf(pair) === sole.choice)
  if (from === undefined || !isScalar(from.value) || !from.value.range) return null
  const wanted = String(to).toLowerCase()
  const onto = node.items.find((pair) => keyOf(pair)?.toLowerCase() === wanted)
  if (onto === from) return null
  const edits: Edit[] = [{ start: from.value.range[0], end: from.value.range[1], text: '0' }]
  let choice = String(to)
  if (onto === undefined) {
    const added = appendTo(source, node, [`${key}: ${sole.weight}`])
    if (added === null) return null
    edits.push(added)
  } else {
    if (!isScalar(onto.value) || !onto.value.range) return null
    edits.push({ start: onto.value.range[0], end: onto.value.range[1], text: String(sole.weight) })
    choice = keyOf(onto) ?? choice
  }
  return { edits, value: withField(withField(weights, sole.choice, 0), choice, sole.weight) }
}

/**
 * `source` with `changes` written in the block section of `game`, every other character kept: a
 * plain value replaced, the weight of a one-choice mapping moved (`moveWeight`), a missing option
 * added after the last one. With the section as it then reads (`section`: as it reads now). Null when
 * the section is not a block mapping, or a value is none of those.
 */
function editInPlace(
  source: string,
  doc: Document.Parsed,
  section: Record<string, unknown>,
  game: string,
  changes: readonly OptionChange[],
): { text: string; section: Record<string, unknown> } | null {
  const root = doc.contents
  const node = isMap(root) ? root.get(game, true) : undefined
  if (!isMap(node) || node.flow || node.items.length === 0) return null

  const edits: Edit[] = []
  const added: string[] = []
  let after = section
  for (const change of changes) {
    const value = scalarText(change.to)
    if (value === null) return null
    const pair = node.items.find((item) => keyOf(item) === change.key)
    if (pair === undefined) {
      added.push(`${quoteIfAmbiguous(change.key)}: ${value}`)
      after = withField(after, change.key, change.to)
    } else if (isScalar(pair.value) && pair.value.range) {
      const [start, end] = pair.value.range
      // `key:` with nothing after it: the value goes after the colon.
      edits.push({ start, end, text: start === end ? ` ${value}` : value })
      after = withField(after, change.key, change.to)
    } else {
      const moved = moveWeight(source, pair.value, section[change.key], change.to)
      if (moved === null) return null
      edits.push(...moved.edits)
      after = withField(after, change.key, moved.value)
    }
  }
  if (added.length > 0) {
    const edit = appendTo(source, node, added)
    if (edit === null) return null
    edits.push(edit)
  }
  // From the end of the text; at the same place, the later edit first: an option added after the
  // section's last mapping then comes after the choice added at the end of that mapping.
  const text = [...edits]
    .reverse()
    .sort((x, y) => y.start - x.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), source)
  return { text, section: after }
}

/** `source` with the document `doc` written anew by the writer (its own comments are lost). */
function rewriteDoc(source: string, doc: Document.Parsed, expected: EditorDoc, schema?: GameSchema): string {
  const range = doc.contents?.range
  if (!range) throw new AppError('AP_YAML_INVALID', undefined, { detail: 'a document without contents' })
  const [start, end] = range
  const text = renderPlayerYaml(expected, schema)
  return (
    source.slice(0, start) + (source[end - 1] === '\n' ? text : text.replace(/\n$/, '')) + source.slice(end)
  )
}

/** The documents of `text` as Archipelago reads them, the empty ones left out (as PlayerDoc.index). */
const loadedDocs = (text: string): unknown[] =>
  loadYaml11(text).docs.filter((data) => data !== null && data !== undefined)

/**
 * `text` with the options of `changes` set in its player document `docIndex` (as PlayerDoc.index
 * counts them). Only those values change, the rest of the file stays as it was, comments included;
 * an option the template way (weights on one choice) keeps its weights, moved onto the new value. A
 * document whose section cannot be edited that way (none, `{}`, a flow mapping, an anchor…) is
 * written anew by the writer, as the Studio does, the other documents still untouched. Windows line
 * ends are kept. AP_YAML_INVALID for a file Archipelago cannot read, NOT_FOUND for a document it does
 * not have.
 */
export function rewriteOptions(
  text: string,
  docIndex: number,
  changes: readonly OptionChange[],
  schema?: GameSchema,
): string {
  const source = plainText(text)
  const { docs: editors, issues } = parsePlayerYaml(source)
  if (issues.length > 0) throw new AppError('AP_YAML_INVALID', undefined, { detail: issues[0]?.code })
  const editor = editors[docIndex]
  const doc = parseYamlDocuments(source).docs.filter((parsed) => !isEmptyDoc(parsed))[docIndex]
  if (editor === undefined || doc === undefined) {
    throw new AppError('NOT_FOUND', undefined, { detail: `player document ${docIndex}` })
  }
  const game = editor.game
  const loaded = loadedDocs(source)
  const data = loaded[docIndex]
  const section = isRecord(data) && Object.hasOwn(data, game) ? data[game] : undefined
  const edited = isRecord(section) ? editInPlace(source, doc, section, game, changes) : null
  // An edit in place is kept only when the file then reads as expected (not so with an anchor).
  const expected =
    edited === null || !isRecord(data)
      ? null
      : loaded.map((other, i) => (i === docIndex ? withField(data, game, edited.section) : other))
  const out =
    edited !== null && expected !== null && isDeepStrictEqual(loadedDocs(edited.text), expected)
      ? edited.text
      : rewriteDoc(source, doc, withChanges(editor, changes), schema)
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out
}

// --- the balancer ----------------------------------------------------------------------------------------

export interface SuggestInput {
  sessionId: string
  fileId: string
  /** The player document, as PlayerDoc.index counts them. */
  docIndex: number
  target: BalanceTarget
}

export interface Balancer {
  /**
   * The proposals for one player document of a session (task stages `prepare`, `generate` with the
   * measures `done`, then `done`), kept an hour for `apply`. The target is taken from the session's
   * last checks (INVALID_INPUT before any, except for a number of checks); the player is measured
   * first, and its error ends the task (AP_ROM_MISSING…). INVALID_INPUT for a document that rolls its
   * game; NOT_FOUND for an unknown document; CHECKS_NO_SCHEMA for a game without an option schema.
   */
  suggest(input: SuggestInput, task: TaskHandle): Promise<BalanceProposal[]>
  /**
   * Writes the proposal's options in its file (rewriteOptions), which the store validates again.
   * NOT_FOUND for a proposal that is unknown, more than an hour old, of another file, or made before
   * the file last changed (applying one changes it: the others of that file go).
   */
  apply(input: { sessionId: string; fileId: string; proposalId: string }): Promise<Session>
}

export interface BalancerDeps {
  templates: Pick<Templates, 'getSchema'>
  measurer: Pick<Measurer, 'measureDoc' | 'lastSession'>
  sessions: Pick<SessionStore, 'readFile' | 'replaceFile'>
  /** The clock of the proposals' hour. Default: `Date.now`. */
  now?: () => number
}

/** A proposal as `apply` needs it. */
interface KeptProposal {
  sessionId: string
  fileId: string
  docIndex: number
  changes: OptionChange[]
  schema: GameSchema
  /** The text it was made from: in another text, its document may have moved. */
  fileHash: string
  expiresAt: number
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const errorOf = (data: AppErrorData): AppError =>
  new AppError(data.code, data.params, {
    ...(data.detail === undefined ? {} : { detail: data.detail }),
    ...(data.logPath === undefined ? {} : { logPath: data.logPath }),
  })

export function createBalancer(ctx: CoreContext, deps: BalancerDeps): Balancer {
  const now = deps.now ?? Date.now
  const kept = new Map<string, KeptProposal>()

  function dropExpired(): void {
    for (const [id, proposal] of kept) if (proposal.expiresAt <= now()) kept.delete(id)
  }

  return {
    async suggest({ sessionId, fileId, docIndex, target }, task) {
      task.progress('prepare', 0)
      const { text } = await deps.sessions.readFile(sessionId, fileId)
      const { docs, issues } = parsePlayerYaml(text)
      if (issues.length > 0) throw new AppError('AP_YAML_INVALID', undefined, { detail: issues[0]?.code })
      const doc = docs[docIndex]
      if (doc === undefined) {
        throw new AppError('NOT_FOUND', undefined, { detail: `${fileId} document ${docIndex}` })
      }
      // A document that rolls its game has no one schema to take options from.
      if (doc.game === '') throw new AppError('INVALID_INPUT', undefined, { detail: 'the game is rolled' })
      const schema = await checkedSchema(deps.templates, doc.game)
      const counts = measuredCounts((await deps.measurer.lastSession(sessionId))?.players ?? [])
      if (target.kind !== 'count' && counts.length === 0) {
        throw new AppError('INVALID_INPUT', undefined, { detail: 'no measured checks in the session' })
      }

      const measureOf = (variant: EditorDoc) =>
        deps.measurer.measureDoc({
          sessionId,
          game: doc.game,
          yamlText: renderPlayerYaml(variant, schema),
          task,
        })
      // The player as it is first (usually kept from the session's measure), then its variants.
      let done = 0
      task.progress('generate', null, { done })
      const measuredNow = await measureOf(doc)
      if (measuredNow.error !== null) throw errorOf(measuredNow.error)
      if (measuredNow.checks === null) throw new AppError('AP_UNKNOWN', undefined, { detail: 'no count' })
      const measured = await proposeBalance({
        schema,
        doc,
        current: measuredNow.checks,
        target: targetOf(counts, target),
        measure: async (variant) => {
          const result = await measureOf(variant)
          task.progress('generate', null, { done: ++done })
          if (result.error !== null) {
            ctx.log.debug('balance: a variant could not be measured', { code: result.error.code })
          }
          return result.error === null ? result.checks : null
        },
      })
      // The diff shown is the file's, as apply will write it (apply only writes into this same text).
      const before = plainText(text)
      const proposals = measured.map((proposal) => ({
        ...proposal,
        diff: lineDiff(before, plainText(rewriteOptions(text, docIndex, proposal.changes, schema))),
      }))

      dropExpired()
      const fileHash = sha256(text)
      const expiresAt = now() + PROPOSAL_TTL_MS
      for (const { id, changes } of proposals) {
        kept.set(id, { sessionId, fileId, docIndex, changes, schema, fileHash, expiresAt })
      }
      task.progress('done', 100)
      return proposals
    },

    async apply({ sessionId, fileId, proposalId }) {
      dropExpired()
      const proposal = kept.get(proposalId)
      if (proposal === undefined || proposal.sessionId !== sessionId || proposal.fileId !== fileId) {
        throw new AppError('NOT_FOUND', undefined, { detail: `proposal ${proposalId}` })
      }
      const { text } = await deps.sessions.readFile(sessionId, fileId)
      if (sha256(text) !== proposal.fileHash) {
        kept.delete(proposalId)
        throw new AppError('NOT_FOUND', undefined, {
          detail: `proposal ${proposalId}: the file changed since`,
        })
      }
      const session = await deps.sessions.replaceFile(
        sessionId,
        fileId,
        rewriteOptions(text, proposal.docIndex, proposal.changes, proposal.schema),
      )
      for (const [id, other] of kept) {
        if (other.sessionId === sessionId && other.fileId === fileId) kept.delete(id)
      }
      return session
    },
  }
}

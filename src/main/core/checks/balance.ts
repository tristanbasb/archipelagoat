// Balancing proposals (spec §3.5). A player whose checks stray from the session's target gets up to
// three proposals, each measured. The options whose name or kind tells the size of the game
// (`sizeCandidates`) are turned one at a time toward fewer or more checks (`variantsToward`), twelve
// of them measured at most; those that move the count the right way are combined greedily, three
// changes at most, and the combination is measured as well. Nothing is written before a proposal is
// applied, and then only its options, in that one document of the file: comments, order and the other
// players stay as they were. A proposal is kept in memory for an hour.
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, type Document, type Node } from 'yaml'
import { measuredCounts, targetOf } from '@shared/checks'
import { AppError, type AppErrorData } from '@shared/errors'
import { setOptionValue } from '@shared/studio-model'
import type {
  BalanceProposal,
  BalanceTarget,
  EditorDoc,
  GameSchema,
  OptionChange,
  OptionSchema,
  Session,
} from '@shared/types'
import type { Templates } from '../ap/templates'
import type { CoreContext } from '../context'
import type { SessionStore } from '../sessions/store'
import type { TaskHandle } from '../tasks'
import { parseYamlDocuments } from '../yaml/load'
import { parsePlayerYaml, quoteIfAmbiguous, renderPlayerYaml } from '../yaml/writer'
import type { Measurer } from './measure'

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
function snakeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

const isCommon = (key: string): boolean =>
  COMMON_OPTIONS.has(key) || key.startsWith('plando_') || key.startsWith('start_inventory')

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

/** Toggle.from_any (Options.py): the strings that read as off and as on. */
const TOGGLE_OFF: ReadonlySet<string> = new Set(['off', '0', 'false', 'none', 'null', 'no', 'disabled'])
const TOGGLE_ON: ReadonlySet<string> = new Set(['on', '1', 'true', 'yes', 'enabled'])

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

/** Each size option of the doc turned toward `direction`, in the order of sizeCandidates. */
function singleChanges(schema: GameSchema, doc: EditorDoc, direction: Direction): OptionChange[] {
  return sizeCandidates(schema).flatMap((option) => {
    const set = Object.hasOwn(doc.options, option.key) ? doc.options[option.key] : undefined
    // Weights and raw YAML are the player's own dice or text: they stay.
    if (set !== undefined && set.mode !== 'value') return []
    const from = set === undefined ? option.default : set.value
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

/** The YAML of a value a proposal sets, as PyYAML reads it back; null for any other value. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === 'string' ? quoteIfAmbiguous(value) : null
}

/** The documents parsePlayerYaml leaves out, which PlayerDoc.index does not count. */
const isEmptyDoc = (doc: Document.Parsed): boolean =>
  doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)

/**
 * `source` with the values of `changes` written over the old ones in the block section of `game`,
 * and the options it lacks added after its last one; every other character stays. Null when the
 * section is not a block mapping or a value is more than a scalar.
 */
function editInPlace(
  source: string,
  doc: Document.Parsed,
  game: string,
  changes: readonly OptionChange[],
): string | null {
  const root = doc.contents
  const section = isMap(root) ? root.get(game, true) : undefined
  if (!isMap(section) || section.flow || section.items.length === 0) return null
  const first = section.items[0]?.key
  if (!isScalar(first) || !first.range) return null
  const indent = source.slice(source.lastIndexOf('\n', first.range[0] - 1) + 1, first.range[0])
  if (!/^ *$/.test(indent)) return null

  const edits: { start: number; end: number; text: string }[] = []
  const added: string[] = []
  for (const change of changes) {
    const value = scalarText(change.to)
    if (value === null) return null
    const pair = section.items.find((item) => isScalar(item.key) && item.key.value === change.key)
    if (pair === undefined) {
      added.push(`${indent}${quoteIfAmbiguous(change.key)}: ${value}\n`)
      continue
    }
    if (!isScalar(pair.value) || !pair.value.range) return null
    const [start, end] = pair.value.range
    // `key:` with nothing after it: the value goes after the colon.
    edits.push({ start, end, text: start === end ? ` ${value}` : value })
  }
  if (added.length > 0) {
    const last = section.items.at(-1)
    const tail = (last?.value ?? last?.key) as Node | null | undefined
    if (!tail?.range) return null
    // After the line the last option ends on (a block value ends with its own line break).
    const end = tail.range[1]
    const lineBreak = source[end - 1] === '\n' ? end - 1 : source.indexOf('\n', end)
    const at = lineBreak === -1 ? source.length : lineBreak + 1
    edits.push({ start: at, end: at, text: `${lineBreak === -1 ? '\n' : ''}${added.join('')}` })
  }
  return edits
    .sort((x, y) => y.start - x.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
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

/**
 * `text` with the options of `changes` set in its player document `docIndex` (as PlayerDoc.index
 * counts them). Only those values change, the rest of the file stays as it was, comments included;
 * a document whose section cannot be edited that way (none, `{}`, a flow mapping) is written anew by
 * the writer, as the Studio does, the other documents still untouched. Windows line ends are kept.
 * AP_YAML_INVALID for a file Archipelago cannot read, NOT_FOUND for a document it does not have.
 */
export function rewriteOptions(
  text: string,
  docIndex: number,
  changes: readonly OptionChange[],
  schema?: GameSchema,
): string {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const { docs: editors, issues } = parsePlayerYaml(source)
  if (issues.length > 0) throw new AppError('AP_YAML_INVALID', undefined, { detail: issues[0]?.code })
  const editor = editors[docIndex]
  const doc = parseYamlDocuments(source).docs.filter((parsed) => !isEmptyDoc(parsed))[docIndex]
  if (editor === undefined || doc === undefined) {
    throw new AppError('NOT_FOUND', undefined, { detail: `player document ${docIndex}` })
  }
  const expected = withChanges(editor, changes)
  // An edit in place is kept only when the file reads back as expected (an anchor, an odd layout…).
  const readsBack = (out: string): boolean => {
    const again = parsePlayerYaml(out)
    return (
      again.issues.length === 0 &&
      again.docs.length === editors.length &&
      isDeepStrictEqual(again.docs[docIndex], expected)
    )
  }
  const edited = editInPlace(source, doc, editor.game, changes)
  const out = edited !== null && readsBack(edited) ? edited : rewriteDoc(source, doc, expected, schema)
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
   * game; NOT_FOUND for an unknown document, or a game without an option schema.
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
      const schema = await deps.templates.getSchema(doc.game)
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
      const proposals = await proposeBalance({
        schema,
        doc,
        current: measuredNow.checks,
        target: targetOf(counts, target),
        measure: async (variant) => {
          const measured = await measureOf(variant)
          task.progress('generate', null, { done: ++done })
          if (measured.error !== null) {
            ctx.log.debug('balance: a variant could not be measured', { code: measured.error.code })
          }
          return measured.error === null ? measured.checks : null
        },
      })

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

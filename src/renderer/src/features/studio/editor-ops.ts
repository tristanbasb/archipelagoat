// The Studio's editing operations, on top of the shared model (src/shared/studio-model.ts): simple ⇄
// weighted mode, random, reset, presets, and how an option value reads for its control. Pure
// functions without React: every one returns a new EditorDoc and leaves its input alone.
import { TOGGLE_OFF, TOGGLE_ON } from '@shared/data/ap-constants'
import { applyPreset, docFromSchema, setOptionValue } from '@shared/studio-model'
import type { EditorDoc, GameSchema, Issue, OptionChange, OptionSchema, OptionValue } from '@shared/types'

/** Archipelago's own random pick, valid for every weighted option (Toggle, Choice, Range…). */
export const RANDOM = 'random'

/** The random variants of a Range (Options.py, Range.from_text). */
export const RANGE_RANDOMS = ['random', 'random-low', 'random-middle', 'random-high'] as const

/** The weight of a value the user adds, Archipelago's default weight. */
export const DEFAULT_WEIGHT = 50

/** Kinds Archipelago never weights: their value is edited as YAML text. */
const RAW_KINDS: ReadonlySet<OptionSchema['kind']> = new Set(['list', 'set', 'dict', 'free'])

export type EditorMode = 'simple' | 'weighted' | 'raw'

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/**
 * Whether Archipelago reads `value` as its own random pick for this option (Options.py, from_text),
 * as the validator does. A value that names one of the option's choices (`randomize_recipe`), or a
 * special name of a named range, never does. Toggle takes `random` as it is, Choice and TextChoice
 * in any case; only a Range takes every `random…` text (`random-low`, `random-range-1-10`). Raw
 * kinds have no random pick.
 */
export function isRandom(option: OptionSchema, value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.toLowerCase()
  if (option.choices.some((choice) => choice.toLowerCase() === text)) return false
  switch (option.kind) {
    case 'toggle':
      return value === RANDOM
    case 'choice':
    case 'text-choice':
      return text === RANDOM
    case 'named-range':
      return !Object.hasOwn(option.specialNames, text) && text.startsWith(RANDOM)
    case 'range':
      return text.startsWith(RANDOM)
    default:
      return false
  }
}

export const isRawKind = (option: OptionSchema): boolean => RAW_KINDS.has(option.kind)

/** The control an option value needs. */
export function editorMode(option: OptionSchema, value: OptionValue | undefined): EditorMode {
  if (isRawKind(option) || value?.mode === 'raw') return 'raw'
  if (value?.mode === 'weighted') return 'weighted'
  // A list or a mapping given to a simple option is beyond its control.
  if (value?.mode === 'value' && isObject(value.value)) return 'raw'
  return 'simple'
}

/** What a simple control shows: the doc's value, else the option's default. */
export function simpleValue(option: OptionSchema, value: OptionValue | undefined): unknown {
  return value?.mode === 'value' ? value.value : option.default
}

/**
 * On, off, random, or null for a value that is none of them. Toggle.from_text takes `random` alone,
 * as it is: `random-low` or `Random` is refused, not a random pick.
 */
export function toggleState(value: unknown): boolean | 'random' | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return null
  if (value === RANDOM) return 'random'
  const text = value.trim().toLowerCase()
  if (TOGGLE_ON.has(text)) return true
  if (TOGGLE_OFF.has(text)) return false
  return null
}

/** The number a range value stands for (a special name gives its number); null for random or text. */
export function rangeNumber(option: OptionSchema, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (Object.hasOwn(option.specialNames, text)) return option.specialNames[text] ?? null
  return /^[-+]?\d+$/.test(text) ? Number(text) : null
}

/** The key a value takes among weights: `'true'`, `'25'`, `'crystals'`; null when it has none. */
export function weightKey(value: unknown): string | null {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
  if (typeof value === 'string' && value.trim() !== '') return value
  return null
}

/** A weights key back to the value it names for this option. */
function valueOfKey(option: OptionSchema, key: string): unknown {
  if (option.kind === 'toggle') {
    const state = toggleState(key)
    return state === null ? key : state
  }
  if (option.kind === 'range' || option.kind === 'named-range') {
    return /^[-+]?\d+$/.test(key.trim()) ? Number(key) : key
  }
  return key
}

/** `doc` without `key`; the same doc when it has no such option. */
export function removeOption(doc: EditorDoc, key: string): EditorDoc {
  if (!Object.hasOwn(doc.options, key)) return doc
  return { ...doc, options: Object.fromEntries(Object.entries(doc.options).filter(([k]) => k !== key)) }
}

/** The option in weighted mode: its current value (or default) at weight 50. */
export function toWeighted(option: OptionSchema, doc: EditorDoc): EditorDoc {
  const current = doc.options[option.key]
  if (current?.mode === 'weighted') return doc
  const fromDoc = current?.mode === 'value' ? weightKey(current.value) : null
  const key = fromDoc ?? weightKey(option.default) ?? RANDOM
  return setOptionValue(doc, option.key, { mode: 'weighted', weights: { [key]: DEFAULT_WEIGHT } })
}

/** The option back to one value: the heaviest of its weights (the default when they are all 0). */
export function toSimple(option: OptionSchema, doc: EditorDoc): EditorDoc {
  const current = doc.options[option.key]
  if (current?.mode !== 'weighted') return doc
  let best: [string, number] | null = null
  for (const entry of Object.entries(current.weights)) if (entry[1] > (best?.[1] ?? 0)) best = entry
  if (!best) return resetOption(option, doc)
  return setOptionValue(doc, option.key, { mode: 'value', value: valueOfKey(option, best[0]) })
}

/** The option left to Archipelago's random pick. */
export function randomize(doc: EditorDoc, key: string): EditorDoc {
  return setOptionValue(doc, key, { mode: 'value', value: RANDOM })
}

/**
 * New weights for an option. With none left the option goes: Archipelago rejects an empty mapping,
 * and without the key it uses the default.
 */
export function setWeights(doc: EditorDoc, key: string, weights: Record<string, number>): EditorDoc {
  if (Object.keys(weights).length === 0) return removeOption(doc, key)
  return setOptionValue(doc, key, { mode: 'weighted', weights })
}

/** The option at its default; left out when it has none (Archipelago then uses its own). */
export function resetOption(option: OptionSchema, doc: EditorDoc): EditorDoc {
  if (option.default === null || option.default === undefined) return removeOption(doc, option.key)
  return setOptionValue(doc, option.key, { mode: 'value', value: option.default })
}

/** True when the doc sets the option to something else than its default. */
export function isModified(option: OptionSchema, value: OptionValue | undefined): boolean {
  if (value === undefined) return false
  if (value.mode !== 'value') return true
  return JSON.stringify(value.value) !== JSON.stringify(option.default ?? null)
}

/** The doc reset to the schema's defaults, the player staying: name, description, requires and the other root keys. */
function atDefaults(schema: GameSchema, doc: EditorDoc): EditorDoc {
  const base: EditorDoc = {
    ...docFromSchema(schema, doc.name),
    description: doc.description,
    extraRoot: doc.extraRoot,
  }
  if (doc.requiresVersion !== null) base.requiresVersion = doc.requiresVersion
  return base
}

/** The doc reset to the schema's defaults, then set to a preset (`null`: the defaults alone). */
export function withPreset(schema: GameSchema, doc: EditorDoc, preset: string | null): EditorDoc {
  const base = atDefaults(schema, doc)
  const values = preset === null ? undefined : schema.presets[preset]
  return values ? applyPreset(base, values) : base
}

/**
 * The doc reset to the schema's defaults, then set to an ArchipelaGOAT profile: the changes of a
 * profile are relative to the defaults, so Standard (no change) is the defaults alone.
 */
export function withProfile(schema: GameSchema, doc: EditorDoc, changes: readonly OptionChange[]): EditorDoc {
  return applyPreset(atDefaults(schema, doc), Object.fromEntries(changes.map(({ key, to }) => [key, to])))
}

export type IssueTarget = { kind: 'option'; key: string } | { kind: 'name' } | { kind: 'game' }

/**
 * What an issue is about in the editor, from its path: `<game>.<option>`, `name`, `game`, or the game
 * section itself (`<game>`: missing or null), which picking the game again fixes.
 */
export function issueTarget(issue: Issue, game: string): IssueTarget | null {
  const { path } = issue
  if (path === undefined) return null
  if (path === 'name') return { kind: 'name' }
  if (path === 'game' || (game !== '' && path === game)) return { kind: 'game' }
  const prefix = `${game}.`
  if (game !== '' && path.startsWith(prefix) && path.length > prefix.length) {
    return { kind: 'option', key: path.slice(prefix.length) }
  }
  return null
}

/** `progression_balancing` → `Progression balancing`: option and value names, readable. */
export function humanize(name: string): string {
  const spaced = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The file name to propose for a doc: its player name without placeholders, else its game. */
export function suggestedFileName(doc: EditorDoc): string {
  const clean = (text: string): string =>
    text
      .replace(/\{[^}]*\}/g, '')
      .replace(/[<>:"/\\|?*]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
  const base = clean(doc.name) || clean(doc.game) || 'Player'
  return `${base}.yaml`
}

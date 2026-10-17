// Reads the option templates Archipelago writes (`Players/Templates/<game>.yaml`, and the same files
// on archipelago.gg) into the schema the Studio edits (spec §3.10, research brief §1.9). The format
// is the one of data/options.yaml and Options.generate_yaml_templates in Archipelago 0.6.8:
//
//   <game>:                                   the game section, last top-level key
//     ################                        a `# Group #` banner
//     # Game Options #
//     ################
//     goal:                                   an option: a 2-space key
//       # Ganon: Climb GT…                    its doc, `# ` lines
//       ganon: 50                             the default carries 50, the other values 0
//       crystals: 0
//
// Range options add `# Minimum value is N` / `# Maximum value is M` and NamedRange options note
// their special names (`normal: 50 # equivalent to 50`). The template does not give the option's
// class, so the kind is inferred from what it shows; only ranges and toggles are certain.
import { parse } from 'yaml'
import { AppError } from '@shared/errors'
import type { GameSchema, OptionKind, OptionSchema } from '@shared/types'

export interface TemplateHeader {
  game: string | null
  description: string | null
  /** `requires.version`. */
  apVersion: string | null
}

/** Utils.get_file_safe_name: the name of a game's template file, without `.yaml`. */
export function fileSafeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '')
}

/**
 * Archipelago reads its YAML with PyYAML: YAML 1.1 (`'off'` is quoted because `off` is false). A
 * Python tag PyYAML may write in a dict (`!!python/tuple`) is read as the plain collection it holds,
 * without a warning on the console.
 */
const YAML_OPTIONS = { version: '1.1', uniqueKeys: false, logLevel: 'error' } as const

/** The group of an option met before any banner (Options.get_option_groups names it so). */
const DEFAULT_GROUP = 'Game Options'

/** The lines the `range_option` macro of data/options.yaml writes after a range's doc. */
const RANGE_INTRO = 'You can define additional values between the minimum and maximum values.'
const MINIMUM = /^Minimum value is (-?\d+(?:\.\d+)?)$/
const MAXIMUM = /^Maximum value is (-?\d+(?:\.\d+)?)$/
const EQUIVALENT = /^equivalent to (-?\d+)$/
/** A line of a range: `{{ entry }}: {{ weight }}` and its note, written without YAML quoting. */
const RANGE_LINE = /^(.+?): (-?\d+)(?:\s+#\s?(.*?))?\s*$/

const DEFAULT_WEIGHT = 50

/**
 * The PerGameCommonOptions that are sets (ItemSet, LocationSet; Options.py:1473-1526). A template
 * writes sets and lists the same way, so every other sequence is taken for a list.
 */
const SET_OPTIONS: ReadonlySet<string> = new Set([
  'local_items',
  'non_local_items',
  'start_hints',
  'start_location_hints',
  'exclude_locations',
  'priority_locations',
])

const TOGGLE_KEYS: ReadonlySet<string> = new Set(['false', 'true'])

interface RawOption {
  key: string
  group: string
  /** The comment lines before the value, without their `#` and one space. */
  comments: string[]
  /** The value lines, without the 4 spaces of the option's indentation. */
  values: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const splitLines = (text: string): string[] => text.replace(/^\uFEFF/, '').split(/\r?\n/)

/** Data as it crosses IPC: a YAML 1.1 `!!set` becomes an array, an `!!omap` an object. */
function toPlain(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(toPlain)
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v)]))
  if (Array.isArray(value)) return value.map(toPlain)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]))
  return value
}

const parseYaml = (text: string): unknown => toPlain(parse(text, YAML_OPTIONS))

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The line of the game section: the last top-level key without a value; -1 when there is none. */
const sectionIndex = (lines: string[]): number => lines.findLastIndex((line) => /^[^\s#].*:\s*$/.test(line))

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : null
}

function headerOf(lines: string[]): TemplateHeader {
  let data: unknown
  try {
    data = parseYaml(lines.join('\n'))
  } catch {
    data = null
  }
  const root = isRecord(data) ? data : {}
  const requires = isRecord(root.requires) ? root.requires : {}
  return {
    game: typeof root.game === 'string' ? root.game : null,
    description: typeof root.description === 'string' ? root.description : null,
    apVersion: textOf(requires.version),
  }
}

/** The header of a template (what comes before the game section); nulls for what it lacks. */
export function readTemplateHeader(text: string): TemplateHeader {
  const lines = splitLines(text)
  const at = sectionIndex(lines)
  return headerOf(at === -1 ? lines : lines.slice(0, at))
}

function sectionKey(line: string): string | null {
  try {
    const data = parseYaml(line)
    const keys = isRecord(data) ? Object.keys(data) : []
    return keys.length === 1 ? (keys[0] ?? null) : null
  } catch {
    return null
  }
}

/** `    # text` → `text`: the `#` and one space go, the rest of the indentation stays. */
const commentText = (line: string): string => line.trimStart().replace(/^# ?/, '').trimEnd()

/** The options of the game section, with their group, in template order. */
function readOptions(lines: string[]): RawOption[] {
  const options: RawOption[] = []
  let group = DEFAULT_GROUP
  let current: RawOption | null = null
  for (const line of lines) {
    if (line.trim() === '') {
      // A blank line inside a value (a folded string of a dict) belongs to it.
      if (current && current.values.length > 0) current.values.push('')
      continue
    }
    const indent = indentOf(line)
    if (indent <= 2) {
      current = null
      const body = line.trim()
      if (body.startsWith('#')) {
        // `# Group #` names the group; the `####` bars around it say nothing.
        const name = /^# (.*) #$/.exec(body)?.[1]
        if (name !== undefined) group = name
        continue
      }
      const key = indent === 2 ? /^(.+?):$/.exec(body)?.[1] : undefined
      if (key !== undefined) {
        current = { key, group, comments: [], values: [] }
        options.push(current)
      }
      continue
    }
    if (!current) continue
    if (current.values.length === 0 && line.trimStart().startsWith('#'))
      current.comments.push(commentText(line))
    else current.values.push(line.slice(Math.min(indent, 4)))
  }
  return options
}

/** The doc of an option, and the bounds a range writes after it. */
function splitDoc(comments: string[]): { doc: string; range: { min: number; max: number } | null } {
  const lines = [...comments]
  let range: { min: number; max: number } | null = null
  const min = MINIMUM.exec(lines.at(-2) ?? '')
  const max = MAXIMUM.exec(lines.at(-1) ?? '')
  if (min && max) {
    range = { min: Number(min[1]), max: Number(max[1]) }
    lines.splice(-2)
    if (lines.at(-1) === RANGE_INTRO) lines.pop()
  }
  while (lines.at(-1) === '') lines.pop()
  while (lines[0] === '') lines.shift()
  return { doc: lines.join('\n'), range }
}

function schema(
  raw: RawOption,
  doc: string,
  kind: OptionKind,
  value: unknown,
  extra: Partial<Pick<OptionSchema, 'choices' | 'range' | 'specialNames'>> = {},
): OptionSchema {
  const exact = kind === 'range' || kind === 'named-range' || kind === 'toggle'
  return {
    key: raw.key,
    group: raw.group,
    doc,
    kind,
    default: value,
    choices: extra.choices ?? [],
    range: extra.range ?? null,
    specialNames: extra.specialNames ?? {},
    confidence: exact ? 'exact' : 'inferred',
  }
}

/** The first entry with the highest weight above 0, the value the template defaults to. */
function heaviest<T extends { weight: number }>(entries: T[]): T | null {
  let best: T | null = null
  for (const entry of entries) if (entry.weight > 0 && (!best || entry.weight > best.weight)) best = entry
  return best
}

/**
 * A range: its entries are written as they are, not YAML-quoted. The default is the entry weighted
 * 50: a number, a special name (taken as its number) or a `random…` text (kept as written).
 */
function rangeOption(raw: RawOption, doc: string, range: { min: number; max: number }): OptionSchema {
  const entries = raw.values.flatMap((line) => {
    const m = RANGE_LINE.exec(line)
    return m ? [{ key: m[1] ?? '', weight: Number(m[2]), note: m[3] ?? '' }] : []
  })
  const specialNames = Object.fromEntries(
    entries.flatMap(({ key, note }) => {
      const m = EQUIVALENT.exec(note)
      return m ? [[key, Number(m[1])] as const] : []
    }),
  )
  const top = heaviest(entries)
  let value: unknown = null
  if (top && /^-?\d+$/.test(top.key)) value = Number(top.key)
  else if (top && Object.hasOwn(specialNames, top.key)) value = specialNames[top.key]
  else if (top) value = top.key
  const kind = Object.keys(specialNames).length > 0 ? 'named-range' : 'range'
  return schema(raw, doc, kind, value, { range, specialNames })
}

/** Every value is a weight of 0 except one of 50: what the template writes for a pick of values. */
function isDefaultPick(weights: unknown[]): boolean {
  return (
    weights.every((w) => w === 0 || w === DEFAULT_WEIGHT) &&
    weights.filter((w) => w === DEFAULT_WEIGHT).length === 1
  )
}

function valueOption(raw: RawOption, doc: string): OptionSchema {
  let value: unknown
  try {
    value = parseYaml(raw.values.join('\n')) ?? null
  } catch {
    return schema(raw, doc, 'free', null)
  }
  if (Array.isArray(value)) return schema(raw, doc, SET_OPTIONS.has(raw.key) ? 'set' : 'list', value)
  if (!isRecord(value)) return schema(raw, doc, 'free', value)

  const keys = Object.keys(value)
  const weights = Object.values(value)
  const picked = keys.find((key) => value[key] === DEFAULT_WEIGHT)
  if (picked === undefined || !isDefaultPick(weights)) return schema(raw, doc, 'dict', value)
  if (keys.every((key) => TOGGLE_KEYS.has(key)))
    return schema(raw, doc, 'toggle', picked === 'true', { choices: keys })
  // A single weighted text, outside any list of choices: what the template writes for a FreeText.
  if (keys.length === 1) return schema(raw, doc, 'text-choice', picked)
  return schema(raw, doc, 'choice', picked, { choices: keys })
}

function toOption(raw: RawOption): OptionSchema {
  const { doc, range } = splitDoc(raw.comments)
  return range ? rangeOption(raw, doc, range) : valueOption(raw, doc)
}

/**
 * The schema of an Archipelago template. `source` is `'local'` and `presets` empty: the provider
 * sets them. Groups keep the template's order (`Game Options` first when the world has it); a group
 * without options is left out. Throws YAML_PARSE when the text is not a template.
 */
export function parseTemplate(text: string): GameSchema {
  const lines = splitLines(text)
  const at = sectionIndex(lines)
  const header = at === -1 ? null : headerOf(lines.slice(0, at))
  const game = header?.game ?? null
  if (game === null || sectionKey(lines[at] ?? '') !== game) {
    throw new AppError('YAML_PARSE', undefined, { detail: 'not an Archipelago options template' })
  }

  const groups = new Map<string, OptionSchema[]>()
  for (const raw of readOptions(lines.slice(at + 1))) {
    const list = groups.get(raw.group) ?? []
    list.push(toOption(raw))
    groups.set(raw.group, list)
  }
  return {
    game,
    source: 'local',
    apVersion: header?.apVersion ?? null,
    groups: [...groups].map(([name, options]) => ({ name, options })),
    presets: {},
  }
}

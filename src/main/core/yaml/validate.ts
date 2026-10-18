// Checks player YAMLs without running Python (spec §3.10, research brief §1.9): the rules of
// Generate.py (main, roll_settings, handle_name, get_choice) and of the option classes of Options.py
// (Toggle, Choice, TextChoice, Range, NamedRange), against the installed worlds and the option schema
// when there is one. Every problem is an Issue the renderer translates. An error is something
// Archipelago fails on (or silently changes, like a name cut to 16 characters); a warning is something
// it ignores, or that the schema is not sure about (a Choice may have aliases the template does not
// list, so an unknown name is a warning).
import { TOGGLE_OFF, TOGGLE_ON } from '@shared/data/ap-constants'
import type { GameSchema, Issue, OptionSchema, PlayerDoc, PlayerFile } from '@shared/types'
import { YamlFloat } from './load'

export interface ValidationContext {
  /**
   * The games Archipelago loads (exact case), with the world_version of the world it loads and, for a
   * custom world, its file (or folder).
   */
  installedGames: Map<string, { worldVersion: string | null; file?: string }>
  /** The installed Archipelago version; '' when unknown. */
  apVersion: string
  schemaFor(game: string): GameSchema | undefined
  allowQuantity: boolean
  /** The plando modules of the generation, lower case: `bosses`, `items`, `texts`, `connections`. */
  plandoEnabled: string[]
  /**
   * The modules of loaded custom worlds whose game cannot be read (no manifest game, none in their
   * code). Archipelago 0.6 loads them, so a game no other world provides may be theirs: it is then a
   * warning (`game-unconfirmed`), not an error.
   */
  unknownWorlds?: readonly string[]
}

const NAME_MAX = 16
const RESERVED_NAME = 'Archipelago'
/** PerGameCommonOptions that are not CommonOptions: refused at the root (Generate.py roll_settings). */
const GAME_SECTION_ONLY = new Set([
  'local_items',
  'non_local_items',
  'start_inventory',
  'start_hints',
  'start_location_hints',
  'exclude_locations',
  'priority_locations',
  'item_links',
  'plando_items',
])
const PLANDO_MODULES = new Set(['items', 'connections', 'texts', 'bosses'])
/** Keys of a game section that are not options. */
const SECTION_KEYS = new Set(['triggers'])
const ALTTP = 'A Link to the Past'
const ALTTP_KEYS = new Set(['sprite_pool', 'sprite', 'random_sprite_on_event'])
const RANGE_RANDOM = new Set(['random', 'random-low', 'random-middle', 'random-high'])

type Push = (issue: Issue) => void

interface Candidate {
  value: unknown
  weight: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const has = (obj: Record<string, unknown>, key: string): boolean => Object.hasOwn(obj, key)

const isEmptyRecord = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 0

/** Python's int(text): digits with optional sign, underscores between digits, spaces around. */
function pyInt(text: string): number | null {
  return /^\s*[-+]?\d+(?:_\d+)*\s*$/.test(text) ? Number(text.replace(/_/g, '').trim()) : null
}

/** A number as Python sees it: `float` for YamlFloat and non-integers. */
function pyNumber(value: unknown): { n: number; float: boolean } | null {
  if (value instanceof YamlFloat) return { n: value.value, float: true }
  if (typeof value === 'number') return { n: value, float: !Number.isInteger(value) }
  if (typeof value === 'boolean') return { n: value ? 1 : 0, float: false }
  return null
}

const display = (value: unknown): string | number => {
  const num = pyNumber(value)
  if (num && typeof value !== 'boolean') return num.n
  return typeof value === 'string' ? value : String(value instanceof Date ? value.toISOString() : value)
}

/** utils.tuplize_version: exactly three integers. */
function version(text: unknown): [number, number, number] | null {
  if (typeof text !== 'string') return null
  const parts = text.split('.').map(pyInt)
  if (parts.length !== 3 || parts.some((p) => p === null)) return null
  return parts as [number, number, number]
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

/** The leading x.y.z of a version string such as `0.6.8` or `0.6.9-rc1`. */
function leadingVersion(text: string | null): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

// --- get_choice ------------------------------------------------------------------------------------

/**
 * What get_choice can pick from `value`: each list entry, each key of weight > 0 (weights go through
 * int()), or the value itself. An empty mapping gives get_choice's default argument; the name, the
 * game and the game options pass none (Generate.roll_settings, handle_option), so it is Python None,
 * held as null. Null when the pick fails (the issue is pushed).
 */
function candidatesOf(value: unknown, path: string, push: Push): Candidate[] | null {
  if (Array.isArray(value)) {
    // random.choices([]) raises IndexError.
    if (value.length === 0) {
      push({ severity: 'error', code: 'option-invalid-value', path, params: { reason: 'empty-list' } })
      return null
    }
    return (value as unknown[]).map((entry) => ({ value: entry, weight: 1 }))
  }
  if (!isRecord(value)) return [{ value, weight: 1 }]
  const entries = Object.entries(value)
  if (entries.length === 0) return [{ value: null, weight: 1 }]
  const weighted: Candidate[] = []
  for (const [key, raw] of entries) {
    // int() of the weight: numbers, booleans and digit strings.
    const digits = typeof raw === 'string' ? pyInt(raw) : null
    const num = pyNumber(raw) ?? (digits === null ? null : { n: digits, float: false })
    if (!num || num.n < 0) {
      push({
        severity: 'error',
        code: 'option-invalid-value',
        path,
        params: { value: key, reason: 'weight' },
      })
      return null
    }
    if (num.float && !Number.isInteger(num.n)) {
      push({ severity: 'warning', code: 'option-float', path, params: { value: num.n } })
    }
    weighted.push({ value: key, weight: Math.trunc(num.n) })
  }
  if (weighted.every((c) => c.weight === 0)) {
    push({ severity: 'error', code: 'weights-all-zero', path })
    return null
  }
  return weighted.filter((c) => c.weight > 0)
}

// --- option values ---------------------------------------------------------------------------------

function invalid(
  path: string,
  value: unknown,
  severity: Issue['severity'] = 'error',
  extra: Record<string, string | number> = {},
): Issue {
  return { severity, code: 'option-invalid-value', path, params: { value: display(value), ...extra } }
}

/** Toggle.from_any: None fails on int(None). */
function checkToggle(value: unknown, path: string, push: Push): void {
  if (typeof value === 'boolean' || pyNumber(value)) return
  if (
    typeof value === 'string' &&
    (value === 'random' || TOGGLE_OFF.has(value.toLowerCase()) || TOGGLE_ON.has(value.toLowerCase()))
  )
    return
  push(invalid(path, value))
}

/** Choice / TextChoice.from_any. Aliases and option ids are unknown: doubts are warnings. */
function checkChoice(option: OptionSchema, value: unknown, path: string, push: Push): void {
  const choices = new Set(option.choices.map((c) => c.toLowerCase()))
  const textChoice = option.kind === 'text-choice'
  if (typeof value === 'number' && Number.isInteger(value)) return
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'boolean') text = String(value)
  // from_text(str(None)): a KeyError unless a choice (or an alias) is named `none`.
  else if (value === null) text = 'none'
  else text = String(display(value))
  const lower = text.toLowerCase()
  if (lower === 'random' || choices.has(lower) || textChoice) return
  // `true`/`false` are aliases of a choice that has `on`/`off`.
  if ((lower === 'true' || lower === 'false') && choices.has('on') && choices.has('off')) return
  push(invalid(path, value, 'warning'))
}

/** Range / NamedRange.from_any, from_text and custom_range. */
function checkRange(option: OptionSchema, value: unknown, path: string, push: Push): void {
  const range = option.range ?? { min: -Infinity, max: Infinity }
  const specials = option.specialNames
  const inRange = (n: number): boolean =>
    (n >= range.min && n <= range.max) ||
    (option.kind === 'named-range' && Object.values(specials).includes(n))
  const outOfRange = (v: unknown): Issue => invalid(path, v, 'error', { min: range.min, max: range.max })

  const num = typeof value === 'boolean' ? null : pyNumber(value)
  if (num) {
    if (num.float) push({ severity: 'error', code: 'option-float', path, params: { value: num.n } })
    else if (!inRange(num.n)) push(outOfRange(value))
    return
  }
  if (typeof value !== 'string' && typeof value !== 'boolean' && value !== null) {
    push(invalid(path, value))
    return
  }
  // from_text(str(data)): None reads as `none`, which only a special name of that name takes.
  const text = value === null ? 'none' : String(value).toLowerCase()
  if (option.kind === 'named-range' && Object.hasOwn(specials, text)) return
  if (text.startsWith('random-range-')) {
    const parts = text.split('-')
    const [a, b] = [pyInt(parts.at(-2) ?? ''), pyInt(parts.at(-1) ?? '')]
    if (a === null || b === null) push(invalid(path, value))
    else if (Math.min(a, b) < range.min || Math.max(a, b) > range.max) push(outOfRange(value))
    // `random-range--60-60` splits into ['random', 'range', '', '60', '60']: always 60.
    else if (/^random-range-(?:(?:low|middle|high)-)?-/.test(text)) {
      push(invalid(path, value, 'warning', { reason: 'negative-random-range' }))
    }
    return
  }
  if (RANGE_RANDOM.has(text) || text === 'default' || text === 'high' || text === 'low') return
  if (text === 'true' || text === 'false') {
    // Only when they make sense: a range from 0 whose default is not 0.
    if (range.min !== 0 || option.default === 0) push(invalid(path, value))
    return
  }
  const int = pyInt(text)
  if (int !== null) {
    if (!inRange(int)) push(outOfRange(value))
  } else if (/^\s*[-+]?(?:\d+\.\d*|\.\d+)\s*$/.test(text)) {
    push({ severity: 'error', code: 'option-float', path, params: { value: text } })
  } else {
    push(invalid(path, value))
  }
}

function checkOption(option: OptionSchema, value: unknown, path: string, push: Push): void {
  // Lists, sets and dicts are not weighted; their valid entries are not in the templates.
  if (option.kind === 'list' || option.kind === 'set' || option.kind === 'dict') return
  const candidates = candidatesOf(value, path, push)
  if (!candidates || option.kind === 'free') return
  for (const { value: candidate } of candidates) {
    if (option.kind === 'toggle') checkToggle(candidate, path, push)
    else if (option.kind === 'range' || option.kind === 'named-range')
      checkRange(option, candidate, path, push)
    else checkChoice(option, candidate, path, push)
  }
}

function isMergeTag(key: string): boolean {
  return key.startsWith('+') || key.startsWith('-')
}

function checkSection(
  game: string,
  section: Record<string, unknown>,
  ctx: ValidationContext,
  push: Push,
): void {
  const schema = ctx.schemaFor(game)
  const options = new Map(schema?.groups.flatMap((group) => group.options).map((o) => [o.key, o]))
  for (const [key, value] of Object.entries(section)) {
    const path = `${game}.${key}`
    if (isMergeTag(key)) {
      push({ severity: 'error', code: 'option-invalid-value', path, params: { reason: 'merge-tag' } })
      continue
    }
    if (SECTION_KEYS.has(key) || (game === ALTTP && ALTTP_KEYS.has(key))) continue
    // PlandoItems.verify drops them with a warning on the console.
    if (
      key === 'plando_items' &&
      value !== null &&
      !isEmptyRecord(value) &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      if (!ctx.plandoEnabled.includes('items'))
        push({ severity: 'warning', code: 'plando-items-disabled', path })
    }
    if (!schema) continue
    const option = options.get(key)
    // Hidden options are not in the templates either: only a warning, as Archipelago gives.
    if (!option) push({ severity: 'warning', code: 'option-unknown', path })
    else checkOption(option, value, path, push)
  }
}

// --- games -----------------------------------------------------------------------------------------

/** Levenshtein distance, case-insensitive. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase()
  const t = b.toLowerCase()
  let row = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i++) {
    const next = [i]
    for (let j = 1; j <= t.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (s[i - 1] === t[j - 1] ? 0 : 1),
      )
    }
    row = next
  }
  return row[t.length] ?? 0
}

/** The installed game closest to `game`, when it is close enough to be a typo. */
function suggestion(game: string, installed: Iterable<string>): string | null {
  let best: { name: string; d: number } | null = null
  for (const name of installed) {
    const d = distance(game, name)
    if (!best || d < best.d) best = { name, d }
  }
  return best && best.d <= Math.max(2, Math.floor(game.length / 3)) ? best.name : null
}

function checkGames(doc: Record<string, unknown>, ctx: ValidationContext, push: Push): PlayerDoc['games'] {
  if (!has(doc, 'game') || doc.game === null) {
    push({ severity: 'error', code: 'no-game', path: 'game' })
    return []
  }
  const candidates = candidatesOf(doc.game, 'game', push)
  if (!candidates) return []
  const games = new Map<string, number>()
  let none = false
  for (const { value, weight } of candidates) {
    // None, from `{}` or a null entry: '"game" not specified'.
    if (value === null) none = true
    else if (typeof value === 'string') games.set(value, (games.get(value) ?? 0) + weight)
    else
      push({ severity: 'error', code: 'game-not-installed', path: 'game', params: { game: display(value) } })
  }
  if (none) push({ severity: 'error', code: 'no-game', path: 'game' })
  const unknownWorlds = ctx.unknownWorlds ?? []
  for (const game of games.keys()) {
    const installed = ctx.installedGames.has(game)
    if (!installed && unknownWorlds.length > 0) {
      push({
        severity: 'warning',
        code: 'game-unconfirmed',
        path: 'game',
        params: { game, worlds: unknownWorlds.join(', ') },
      })
    } else if (!installed) {
      const close = suggestion(game, ctx.installedGames.keys())
      push({
        severity: 'error',
        code: 'game-not-installed',
        path: 'game',
        params: close ? { game, suggestion: close } : { game },
      })
    }
    if (!has(doc, game))
      push({ severity: 'error', code: 'game-section-missing', path: game, params: { game } })
    else if (doc[game] === null)
      push({ severity: 'error', code: 'game-section-null', path: game, params: { game } })
    else if (!isRecord(doc[game])) push(invalid(game, doc[game]))
    else if (installed) checkSection(game, doc[game], ctx, push)
  }
  return [...games].map(([game, weight]) => ({ game, weight }))
}

// --- requires --------------------------------------------------------------------------------------

function checkRequires(doc: Record<string, unknown>, ctx: ValidationContext, push: Push): void {
  const requires = doc.requires
  // `if requirements:` in roll_settings: nothing to check when it is falsy for Python.
  const falsy = [undefined, null, false, 0, ''].includes(requires as never)
  if (falsy || isEmptyRecord(requires) || (Array.isArray(requires) && requires.length === 0)) return
  if (!isRecord(requires)) {
    push({ severity: 'error', code: 'requires-version-format', path: 'requires' })
    return
  }
  if (has(requires, 'version')) {
    const required = version(requires.version)
    const installed = leadingVersion(ctx.apVersion)
    if (!required) {
      push({
        severity: 'error',
        code: 'requires-version-format',
        path: 'requires.version',
        params: { version: display(requires.version) },
      })
    } else if (installed && compare(required, installed) > 0) {
      push({
        severity: 'error',
        code: 'requires-version-too-new',
        path: 'requires.version',
        params: { required: required.join('.'), installed: ctx.apVersion },
      })
    }
  }
  if (has(requires, 'plando')) checkRequiredPlando(requires.plando, ctx, push)
  if (has(requires, 'game')) checkRequiredWorlds(requires.game, ctx, push)
}

/** PlandoOptions.from_option_string: a comma string of known modules, all enabled. */
function checkRequiredPlando(plando: unknown, ctx: ValidationContext, push: Push): void {
  const path = 'requires.plando'
  if (typeof plando !== 'string') {
    push({ severity: 'error', code: 'requires-plando-disabled', path, params: { module: display(plando) } })
    return
  }
  for (const part of plando.split(',')) {
    const module = part.trim().toLowerCase()
    if (module === '') continue
    if (!PLANDO_MODULES.has(module) || !ctx.plandoEnabled.includes(module)) {
      push({ severity: 'error', code: 'requires-plando-disabled', path, params: { module } })
    }
  }
}

/** `requires.game`: each installed world against `"x.y.z"` or `{min, max}`. */
function checkRequiredWorlds(games: unknown, ctx: ValidationContext, push: Push): void {
  if (!isRecord(games)) {
    push({ severity: 'error', code: 'requires-version-format', path: 'requires.game' })
    return
  }
  for (const [game, wanted] of Object.entries(games)) {
    const world = ctx.installedGames.get(game)
    if (!world) continue
    const path = `requires.game.${game}`
    const bounds =
      typeof wanted === 'string' && wanted !== ''
        ? { min: wanted }
        : isRecord(wanted) && !isEmptyRecord(wanted)
          ? wanted
          : null
    const parsed = bounds && {
      min: has(bounds, 'min') ? version(bounds.min) : undefined,
      max: has(bounds, 'max') ? version(bounds.max) : undefined,
    }
    if (!parsed || parsed.min === null || parsed.max === null) {
      push({ severity: 'error', code: 'requires-version-format', path, params: { game } })
      continue
    }
    const installed = version(world.worldVersion)
    if (!installed) continue
    const failed =
      parsed.min && compare(parsed.min, installed) > 0
        ? parsed.min
        : parsed.max && compare(parsed.max, installed) < 0
          ? parsed.max
          : null
    if (failed) {
      push({
        severity: 'error',
        code: 'requires-game-version',
        path,
        params: { game, required: failed.join('.'), installed: world.worldVersion ?? '' },
      })
    }
  }
}

// --- names -----------------------------------------------------------------------------------------

/** os.path.splitext(os.path.basename(path))[0]. */
function fileStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const lead = /^\.*/.exec(base)?.[0].length ?? 0
  const dot = base.lastIndexOf('.')
  return dot >= lead && dot > 0 ? base.slice(0, dot) : base
}

const codePoints = (s: string): string[] => Array.from(s)

interface ResolvedName {
  /** After substitution and strip, before the cut to 16 characters. */
  full: string
  /** The slot name Archipelago uses. */
  final: string
}

/**
 * Generate.handle_name: `%number%`/`%player%`, then `{number}`, `{NUMBER}`, `{player}`, `{PLAYER}`
 * with str.format rules (`{{`/`}}`, unknown fields kept), strip, cut to 16, strip. Null when
 * str.format would raise (a lone `}` or an unclosed `{`).
 */
function resolveName(name: string, number: number, player: number): ResolvedName | null {
  const values: Record<string, string> = {
    number: String(number),
    NUMBER: number > 1 ? String(number) : '',
    player: String(player),
    PLAYER: player > 1 ? String(player) : '',
  }
  const legacy = name
    .split('%%')
    .map((part) => part.replaceAll('%number%', '{number}').replaceAll('%player%', '{player}'))
    .join('%')
  let out = ''
  for (let i = 0; i < legacy.length; i++) {
    const ch = legacy[i]
    if (ch === '{' && legacy[i + 1] === '{') {
      out += '{'
      i++
    } else if (ch === '}' && legacy[i + 1] === '}') {
      out += '}'
      i++
    } else if (ch === '{') {
      const end = legacy.indexOf('}', i)
      if (end === -1) return null
      const field = legacy.slice(i + 1, end)
      // The field name, before a conversion (`!r`) or a format spec (`:>3`).
      const key = /^[^!:]*/.exec(field)?.[0] ?? ''
      out += Object.hasOwn(values, key) ? values[key] : `{${key}}`
      i = end
    } else if (ch === '}') {
      return null
    } else {
      out += ch
    }
  }
  const full = out.trim()
  return { full, final: codePoints(full).slice(0, NAME_MAX).join('').trim() }
}

/** The checks of handle_name and of the spec on one name. */
function checkName(name: string, resolved: ResolvedName | null, push: Push): void {
  if (!resolved) {
    push({
      severity: 'error',
      code: 'option-invalid-value',
      path: 'name',
      params: { value: name, reason: 'format' },
    })
    return
  }
  if (codePoints(resolved.full).length > NAME_MAX) {
    push({
      severity: 'error',
      code: 'name-too-long',
      path: 'name',
      params: { name: resolved.full, max: NAME_MAX },
    })
  }
  if (resolved.final === RESERVED_NAME) push({ severity: 'error', code: 'name-reserved', path: 'name' })
  else if (/^\d+$/.test(resolved.final)) push({ severity: 'warning', code: 'name-numeric', path: 'name' })
}

/** The name before substitution (from the file name when missing); null when it is not one string. */
function nameOf(
  doc: Record<string, unknown>,
  fileName: string,
  number: (base: string) => number,
  player: number,
  push: Push,
): string | null {
  const raw = doc.name
  if (raw === undefined || raw === null) {
    const base = fileStem(fileName)
    checkName(base, resolveName(base, number(base), player), push)
    return base
  }
  if (typeof raw === 'string') {
    checkName(raw, resolveName(raw, number(raw), player), push)
    return raw
  }
  if (Array.isArray(raw) || isRecord(raw)) {
    // A weighted name: whichever is picked must pass. None (`{}` or a null entry) is skipped by
    // Generate.main, which then takes the file name, as when there is no name.
    for (const { value } of candidatesOf(raw, 'name', push) ?? []) {
      const name = value === null ? fileStem(fileName) : value
      if (typeof name === 'string') checkName(name, resolveName(name, 1, player), push)
      else push(invalid('name', value))
    }
    return null
  }
  // handle_name calls name.lower(): anything but a string fails, an unquoted number included.
  const numeric = pyNumber(raw) !== null && typeof raw !== 'boolean'
  push({
    severity: 'error',
    code: numeric ? 'name-numeric' : 'option-invalid-value',
    path: 'name',
    params: { value: display(raw) },
  })
  return null
}

// --- documents -------------------------------------------------------------------------------------

function checkQuantity(doc: Record<string, unknown>, ctx: ValidationContext, push: Push): void {
  if (!has(doc, 'quantity')) return
  const num = pyNumber(doc.quantity)
  if (num && num.n > 1 && !ctx.allowQuantity) {
    push({ severity: 'error', code: 'quantity-disabled', path: 'quantity', params: { quantity: num.n } })
  } else if (!num || num.float || num.n <= 0) {
    push(invalid('quantity', doc.quantity))
  }
}

function checkRoot(doc: Record<string, unknown>, push: Push): void {
  for (const key of Object.keys(doc)) {
    if (GAME_SECTION_ONLY.has(key)) push({ severity: 'error', code: 'root-common-option', path: key })
    else if (isMergeTag(key))
      push({ severity: 'error', code: 'option-invalid-value', path: key, params: { reason: 'merge-tag' } })
  }
}

/**
 * One PlayerDoc per non-empty document of a file (`docs` from loadYaml11), with `index` counting
 * those documents only: the index of the same document in parsePlayerYaml. `name` is the name as
 * written, before placeholder substitution (from the file name when there is none), null when it is
 * not a single string.
 */
export function validatePlayerDocs(docs: unknown[], fileName: string, ctx: ValidationContext): PlayerDoc[] {
  const counter = new Map<string, number>()
  const number = (base: string): number => {
    const next = (counter.get(base.toLowerCase()) ?? 0) + 1
    counter.set(base.toLowerCase(), next)
    return next
  }
  return docs
    .filter((doc) => doc !== null && doc !== undefined)
    .map((doc, index): PlayerDoc => {
      const issues: Issue[] = []
      const push: Push = (issue) => issues.push(issue)
      if (!isRecord(doc)) {
        return {
          index,
          name: null,
          games: [],
          issues: [{ severity: 'error', code: 'yaml-syntax', params: { doc: index + 1 } }],
        }
      }
      const name = nameOf(doc, fileName, number, index + 1, push)
      checkQuantity(doc, ctx, push)
      checkRoot(doc, push)
      checkRequires(doc, ctx, push)
      const games = checkGames(doc, ctx, push)
      return { index, name, games, issues }
    })
}

/** The slot names Archipelago gives, in order: a counter per name, `{player}` the slot. */
function finalNames(docs: PlayerDoc[]): (string | null)[] {
  const counter = new Map<string, number>()
  return docs.map((doc, slot) => {
    if (doc.name === null) return null
    const key = doc.name.toLowerCase()
    const number = (counter.get(key) ?? 0) + 1
    counter.set(key, number)
    return resolveName(doc.name, number, slot + 1)?.final ?? null
  })
}

/** The names worn by more than one player, without case: lower case → [first name, count]. */
function duplicates(names: (string | null)[]): Map<string, [string, number]> {
  const seen = new Map<string, [string, number]>()
  for (const name of names) {
    if (name === null) continue
    const entry = seen.get(name.toLowerCase())
    seen.set(name.toLowerCase(), entry ? [entry[0], entry[1] + 1] : [name, 1])
  }
  return new Map([...seen].filter(([, [, count]]) => count > 1))
}

/**
 * The slot names of a session's players, with the files read in Archipelago's order (sorted without
 * case) and `{number}` resolved by a counter per name; null for a name that is not one.
 */
export function sessionSlotNames(files: PlayerFile[]): (string | null)[] {
  const sorted = [...files].sort((a, b) => {
    const [x, y] = [a.storedName.toLowerCase(), b.storedName.toLowerCase()]
    return x < y ? -1 : x > y ? 1 : 0
  })
  return finalNames(sorted.flatMap((file) => file.docs))
}

/**
 * `name-duplicate` for each name worn by several players of a session (Generate.main: names unique
 * without case), as `sessionSlotNames` gives them. `params.name` is the duplicated slot name.
 */
export function validateSessionNames(files: PlayerFile[]): Issue[] {
  const names = sessionSlotNames(files)
  return [...duplicates(names).values()].map(([name, count]) => ({
    severity: 'error',
    code: 'name-duplicate',
    params: { name, count },
  }))
}

/**
 * The PlayerDocs of one file loaded by loadYaml11: a file that does not load is a single PlayerDoc
 * carrying its YAML issues; names repeated within the file are flagged on their documents.
 */
export function validateLoadedYaml(
  loaded: { docs: unknown[]; issues: Issue[] },
  fileName: string,
  ctx: ValidationContext,
): PlayerDoc[] {
  if (loaded.issues.some((issue) => issue.severity === 'error')) {
    return [{ index: 0, name: null, games: [], issues: loaded.issues }]
  }
  const docs = validatePlayerDocs(loaded.docs, fileName, ctx)
  const names = finalNames(docs)
  const repeated = duplicates(names)
  return docs.map((doc, i) => {
    const name = names[i]
    const count = name === null || name === undefined ? undefined : repeated.get(name.toLowerCase())?.[1]
    if (count === undefined || name === null || name === undefined) return doc
    const issue: Issue = { severity: 'error', code: 'name-duplicate', path: 'name', params: { name, count } }
    return { ...doc, issues: [...doc.issues, issue] }
  })
}

/** The games the documents can roll: the schemas to fetch before validatePlayerDocs. */
export function gamesIn(docs: unknown[]): string[] {
  const games = new Set<string>()
  for (const doc of docs) {
    if (!isRecord(doc)) continue
    const game = doc.game
    if (typeof game === 'string') {
      games.add(game)
    } else if (Array.isArray(game)) {
      for (const g of game) if (typeof g === 'string') games.add(g)
    } else if (isRecord(game)) {
      for (const [g, weight] of Object.entries(game)) {
        const n = pyNumber(weight)?.n ?? (typeof weight === 'string' ? pyInt(weight) : null) ?? 0
        if (Math.trunc(n) > 0) games.add(g)
      }
    }
  }
  return [...games]
}

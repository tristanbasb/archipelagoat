// Profiles (spec §3.6): three ways to play a game, built from its option schema. Standard is the
// defaults with death link off. Découverte also turns the options that tell the size (balancing's
// candidates) toward fewer checks, the difficulty options to the easiest choice they are known to
// have, and the traps off; Complet turns the size options toward more checks and leaves the rest.
// They come first from the names and kinds of the options alone (`heuristicProfiles`): only the
// options whose name tells the size are turned then, never a numeric range that does not say what it
// counts (a price, a cap, a multiplier). Then from measures (`refine`, in the background): Standard,
// each of the first twelve size options alone (numeric ranges included), then each profile. Only the
// size changes whose measured effect goes the right way are kept, Découverte aiming at 50 to 60 % of
// Standard's checks. A refined game is kept in `dataRoot/profiles/<file-safe game>.json` for its
// world version and option schema. A profile equal to Standard is left out.
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { TOGGLE_OFF } from '@shared/data/ap-constants'
import { AppError, type AppErrorData } from '@shared/errors'
import { applyPreset, docFromSchema } from '@shared/studio-model'
import type {
  GameProfile,
  GameProfiles,
  GameSchema,
  OptionChange,
  OptionSchema,
  PlayerMeasure,
  ProfileCounts,
  ProfileId,
} from '@shared/types'
import type { Templates } from '../ap/templates'
import {
  checkedSchema,
  hasSizeName,
  isCommon,
  sizeCandidates,
  snakeKey,
  variantsToward,
} from '../checks/balance'
import type { MeasureLane, MeasurePriority, Measurer } from '../checks/measure'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { writeFileAtomic } from '../system/fsx'
import type { TaskHandle } from '../tasks'
import { compactKey } from '../worlds/catalog'
import { fileSafeName } from '../yaml/template-parser'
import { validatePlayerDocs } from '../yaml/validate'
import { renderPlayerYaml } from '../yaml/writer'

const PROFILE_IDS: readonly ProfileId[] = ['discovery', 'standard', 'complete']
/** The names the YAML's description gives the profiles (`ArchipelaGOAT · Découverte`). */
const PROFILE_NAMES: Record<ProfileId, string> = {
  discovery: 'Découverte',
  standard: 'Standard',
  complete: 'Complet',
}
/** The name of a YAML when the settings have none: Archipelago numbers the players. */
const DEFAULT_NAME = 'Player{number}'
/** The share of Standard's checks Découverte aims at. */
const DISCOVERY_SHARE = { min: 0.5, max: 0.6 }
/** The size options measured alone when a game is refined. */
const MAX_CANDIDATES = 12
/** Where the bar of a refinement stands once every measure is done. */
const MEASURED_PERCENT = 95

/** The choices Découverte gives a difficulty option, the first one it has (spec §3.6). */
const EASY_CHOICES = ['easy', 'casual', 'beginner', 'normal', 'none', 'off', 'no_glitches', 'vanilla']
/** The difficulty options, on snake_case keys: `*difficulty*`, `logic*`, `*glitch*`, `*trick*`. */
const DIFFICULTY_NAMES: readonly RegExp[] = [/difficulty/, /^logic/, /glitch/, /trick/]
const TRAP_NAME = /trap/
const DEATH_LINK = 'death_link'

// --- the changes of each profile ---------------------------------------------------------------------

const isRangeKind = (option: OptionSchema): boolean =>
  option.kind === 'range' || option.kind === 'named-range'

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string'
    ? a.toLowerCase() === b.toLowerCase()
    : isDeepStrictEqual(a, b)

/** The value that turns `option` off: false, 0, or its `off` (or `none`…) choice; undefined if none. */
function offValue(option: OptionSchema): unknown {
  if (option.kind === 'toggle') return false
  if (isRangeKind(option)) {
    const { range } = option
    const zero =
      (range !== null && range.min <= 0 && range.max >= 0) || Object.values(option.specialNames).includes(0)
    return zero ? 0 : undefined
  }
  if (option.kind === 'choice' || option.kind === 'text-choice') {
    return option.choices.find((choice) => TOGGLE_OFF.has(choice.toLowerCase()))
  }
  return undefined
}

/**
 * The easiest choice Découverte knows that `option` has, in the order of EASY_CHOICES (off for a
 * toggle, the number of a special name for a range); undefined when it has none of them.
 */
function easiestValue(option: OptionSchema): unknown {
  if (option.kind === 'toggle') return false
  for (const easy of EASY_CHOICES) {
    if (isRangeKind(option)) {
      if (Object.hasOwn(option.specialNames, easy)) return option.specialNames[easy]
    } else if (option.kind === 'choice' || option.kind === 'text-choice') {
      const found = option.choices.find((choice) => choice.toLowerCase() === easy)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** True when Archipelago takes `value` for the option `key` (validatePlayerDocs finds no error). */
function isValid(schema: GameSchema, key: string, value: unknown): boolean {
  const doc = { name: DEFAULT_NAME, game: schema.game, [schema.game]: { [key]: value } }
  const [player] = validatePlayerDocs([doc], 'Player.yaml', {
    installedGames: new Map([[schema.game, { worldVersion: null }]]),
    apVersion: '',
    schemaFor: (game) => (game === schema.game ? schema : undefined),
    allowQuantity: false,
    plandoEnabled: [],
  })
  return player !== undefined && !player.issues.some((issue) => issue.severity === 'error')
}

/** What the profiles may change of one option. */
interface Planned {
  key: string
  /** The change of each profile that changes the option. */
  changes: Partial<Record<ProfileId, OptionChange>>
  /**
   * For a size option, whether its name tells the size (`named`) or it is a numeric range that does
   * not say what it counts (`range`): refinement keeps either only when measured the right way, and
   * the heuristic profiles turn only the named ones. Null for death link, a trap, a difficulty.
   */
  size: 'named' | 'range' | null
}

/** What the profiles may change, option by option in the schema's order. */
function planOf(schema: GameSchema): Planned[] {
  const size = new Set(sizeCandidates(schema).map((option) => option.key))
  return schema.groups
    .flatMap((group) => group.options)
    .flatMap((option): Planned[] => {
      const name = snakeKey(option.key)
      // Only a valid value of the schema, and only when it is not the default already.
      const change = (to: unknown): OptionChange | undefined =>
        to === undefined || sameValue(option.default, to) || !isValid(schema, option.key, to)
          ? undefined
          : { key: option.key, from: option.default, to }
      const planned = (
        changes: [ProfileId, OptionChange | undefined][],
        kind: Planned['size'],
      ): Planned[] => {
        const made = changes.filter((entry): entry is [ProfileId, OptionChange] => entry[1] !== undefined)
        return made.length === 0 ? [] : [{ key: option.key, changes: Object.fromEntries(made), size: kind }]
      }
      if (name === DEATH_LINK) {
        const off = change(offValue(option))
        return planned(
          PROFILE_IDS.map((id) => [id, off]),
          null,
        )
      }
      // The other options every game has are never touched.
      if (isCommon(name)) return []
      const trap = TRAP_NAME.test(name)
      if (trap && offValue(option) !== undefined) {
        return planned([['discovery', change(offValue(option))]], null)
      }
      if (DIFFICULTY_NAMES.some((pattern) => pattern.test(name))) {
        return planned([['discovery', change(easiestValue(option))]], null)
      }
      // A trap is never turned for the size: Complet would raise it.
      if (trap || !size.has(option.key)) return []
      return planned(
        [
          ['discovery', change(variantsToward(option, option.default, 'fewer')[0])],
          ['complete', change(variantsToward(option, option.default, 'more')[0])],
        ],
        hasSizeName(option.key) ? 'named' : 'range',
      )
    })
}

/** The changes of each profile: those of `plan` that `keeps`, in the schema's order. */
function changesOf(
  plan: readonly Planned[],
  keeps: (planned: Planned, id: ProfileId) => boolean,
): Record<ProfileId, OptionChange[]> {
  const of = (id: ProfileId): OptionChange[] =>
    plan.flatMap((planned) => {
      const change = planned.changes[id]
      return change !== undefined && keeps(planned, id) ? [change] : []
    })
  return { discovery: of('discovery'), standard: of('standard'), complete: of('complete') }
}

/** The profiles, Standard always there and each other one only when it differs from it. */
function assemble(
  game: string,
  changes: Record<ProfileId, OptionChange[]>,
  measures: Partial<Record<ProfileId, PlayerMeasure>>,
  measured: boolean,
): GameProfiles {
  const profiles = PROFILE_IDS.filter(
    (id) => id === 'standard' || !isDeepStrictEqual(changes[id], changes.standard),
  ).map((id): GameProfile => ({
    id,
    changes: changes[id],
    checks: measures[id]?.checks ?? null,
    range: measures[id]?.range ?? null,
  }))
  return { game, profiles, measured }
}

/**
 * The profiles of `schema`'s game from the names and kinds of its options alone, none measured:
 * Standard (death link off), Découverte (the options whose name tells the size toward fewer checks,
 * difficulty to its easiest known choice, traps off) and Complet (those options toward more checks).
 */
export function heuristicProfiles(schema: GameSchema): GameProfiles {
  const changes = changesOf(planOf(schema), (planned) => planned.size !== 'range')
  return assemble(schema.game, changes, {}, false)
}

/**
 * The changes toward fewer checks that bring `base` into 50–60 % of it, as their measures add up: the
 * biggest first, none that would go under 50 %, until it is at 60 % or under.
 */
function aimDiscovery(
  useful: readonly { change: OptionChange; checks: number }[],
  base: number,
): Set<string> {
  let expected = base
  const chosen = new Set<string>()
  for (const { change, checks } of [...useful].sort((a, b) => a.checks - b.checks)) {
    if (expected <= base * DISCOVERY_SHARE.max) break
    const next = expected + checks - base
    if (next >= base * DISCOVERY_SHARE.min) {
      chosen.add(change.key)
      expected = next
    }
  }
  return chosen
}

/** Every value once settled; then the first rejection, if any (a cancelled task). */
async function settleAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises)
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}

const errorOf = (data: AppErrorData): AppError =>
  new AppError(data.code, data.params, {
    ...(data.detail === undefined ? {} : { detail: data.detail }),
    ...(data.logPath === undefined ? {} : { logPath: data.logPath }),
  })

// --- the kept profiles -----------------------------------------------------------------------------------

/** `dataRoot/profiles/<file-safe game>.json`. A file that does not have this shape is as good as none. */
const keptSchema = z.object({
  version: z.literal(1),
  game: z.string(),
  worldVersion: z.string().nullable(),
  schemaHash: z.string(),
  refinedAt: z.string(),
  profiles: z.array(
    z.object({
      id: z.enum(['discovery', 'standard', 'complete']),
      changes: z.array(z.object({ key: z.string(), from: z.unknown(), to: z.unknown() })),
      checks: z.number().int().nonnegative().nullable(),
      range: z.tuple([z.number(), z.number()]).nullable(),
    }),
  ),
})
type Kept = z.infer<typeof keptSchema>

/** What a kept refinement holds for: a world version and an option schema. */
interface Key {
  schema: GameSchema
  worldVersion: string | null
  schemaHash: string
}

/** The options of a schema, which the profiles are made of (not its presets nor where it was read). */
const hashOf = (schema: GameSchema): string =>
  createHash('sha256')
    .update(JSON.stringify([schema.game, schema.groups]))
    .digest('hex')

const profilesOf = (kept: Kept): GameProfiles => ({
  game: kept.game,
  measured: true,
  profiles: kept.profiles.map(({ id, changes, checks, range }) => ({
    id,
    changes: changes.map(({ key, from, to }) => ({ key, from, to })),
    checks,
    range,
  })),
})

/** The counts known of the profiles; null when none is. */
function countsOf(kept: Kept): ProfileCounts | null {
  const counts: ProfileCounts = {}
  for (const { id, checks } of kept.profiles) if (checks !== null) counts[id] = checks
  return Object.keys(counts).length > 0 ? counts : null
}

// --- the profiles ------------------------------------------------------------------------------------------

export interface Profiles {
  /**
   * The game's profiles: refined when a refinement is kept for its world version and option schema,
   * else the heuristic ones. CHECKS_NO_SCHEMA for a game without an option schema.
   */
  get(game: string): Promise<GameProfiles>
  /**
   * Measures the game's profiles (task stages `prepare`, `generate` with the measures `done` /
   * `total`, `done`) and keeps them; the kept ones when they still hold. Rejects with the error of
   * Standard's measure (AP_ROM_MISSING, AP_NOT_INSTALLED…): nothing is kept then. A size option whose
   * measure fails is left out. `checks:changed` tells the renderer the counts changed. Its measures
   * wait with `priority`: background by default, since nobody waits for it.
   */
  refine(game: string, task: TaskHandle, priority?: MeasurePriority | MeasureLane): Promise<GameProfiles>
  /**
   * The player YAML of a profile: `name` (the player's, else `Player{number}`), `description:
   * ArchipelaGOAT · <profile>`, `game`, then every option of the game at its default with the
   * profile's changes. A profile left out (equal to Standard) writes Standard's options.
   */
  yamlFor(game: string, profile: ProfileId, playerName: string): Promise<string>
  /**
   * The player YAML of a profile with what it was made from, read at once: the profile written,
   * Standard (under its own name) for one left out as equal to it (Ruling 26), and whether the
   * game's profiles are refined for its world version and option schema now.
   */
  profileYaml(game: string, profile: ProfileId, playerName: string): Promise<ProfileYaml>
  /**
   * The checks of each refined profile of the games asked, from what is kept (nothing is measured),
   * for the world versions installed now; a name that differs only in accents, case or punctuation is
   * the same game. Null for a game without them.
   */
  cachedCounts(games: readonly string[]): Promise<Map<string, ProfileCounts | null>>
}

/** A profile's YAML (`Profiles.profileYaml`). */
export interface ProfileYaml {
  /** The profile written. */
  profile: ProfileId
  /** Refined; false: made from the option names alone. */
  measured: boolean
  text: string
}

export interface ProfilesDeps {
  templates: Pick<Templates, 'getSchema'>
  measurer: Pick<Measurer, 'measureDoc'>
  /** The version of the world Archipelago loads for the game (its own for a core world); null: none. */
  worldVersion: (game: string) => Promise<string | null>
}

export function createProfiles(ctx: CoreContext, deps: ProfilesDeps): Profiles {
  const dir = path.join(ctx.platform.paths.dataRoot, 'profiles')
  const fileNameOf = (game: string): string => `${fileSafeName(game)}.json`

  /** File name → what it keeps, read from disk once, then kept up to date by `refine`. */
  let kept: Map<string, Kept> | null = null
  function keptProfiles(): Map<string, Kept> {
    if (kept === null) {
      kept = new Map()
      let names: string[] = []
      try {
        names = readdirSync(dir).filter((name) => name.endsWith('.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.log.warn('profiles: cannot list', error)
      }
      for (const name of names) {
        const saved = keptSchema.safeParse(readJsonSync(path.join(dir, name)))
        if (saved.success) kept.set(name, saved.data)
      }
    }
    return kept
  }

  /** What `game`'s profiles depend on now. CHECKS_NO_SCHEMA for a game without an option schema. */
  async function keyOf(game: string): Promise<Key> {
    const schema = await checkedSchema(deps.templates, game)
    return { schema, worldVersion: await deps.worldVersion(game), schemaHash: hashOf(schema) }
  }

  /** The refinement kept for `game` when it holds for `key`. */
  function keptFor(game: string, key: Key): GameProfiles | null {
    const found = keptProfiles().get(fileNameOf(game))
    const holds =
      found?.game === game && found.worldVersion === key.worldVersion && found.schemaHash === key.schemaHash
    return found && holds ? profilesOf(found) : null
  }

  /** `game`'s profiles now, and what they depend on. */
  async function current(game: string): Promise<{ key: Key; profiles: GameProfiles }> {
    const key = await keyOf(game)
    return { key, profiles: keptFor(game, key) ?? heuristicProfiles(key.schema) }
  }

  /** The YAML of a profile's changes over the defaults. */
  function yamlOf(
    schema: GameSchema,
    changes: readonly OptionChange[],
    id: ProfileId,
    player: string,
  ): string {
    const name = player.trim() === '' ? DEFAULT_NAME : player
    const base = { ...docFromSchema(schema, name), description: `ArchipelaGOAT · ${PROFILE_NAMES[id]}` }
    const doc = applyPreset(base, Object.fromEntries(changes.map((change) => [change.key, change.to])))
    return renderPlayerYaml(doc, schema)
  }

  async function keep(key: Key, profiles: GameProfiles): Promise<void> {
    const entry: Kept = {
      version: 1,
      game: profiles.game,
      worldVersion: key.worldVersion,
      schemaHash: key.schemaHash,
      refinedAt: new Date().toISOString(),
      profiles: profiles.profiles,
    }
    const name = fileNameOf(profiles.game)
    await writeFileAtomic(path.join(dir, name), JSON.stringify(entry))
    keptProfiles().set(name, entry)
    ctx.bus.emit('checks:changed', null)
  }

  return {
    async get(game) {
      return (await current(game)).profiles
    },

    async refine(game, task, priority = 'background') {
      task.progress('prepare', 0)
      const key = await keyOf(game)
      const already = keptFor(game, key)
      if (already) {
        task.progress('done', 100)
        return already
      }
      const { schema } = key
      const plan = planOf(schema)
      const { standard: standardChanges } = changesOf(plan, () => true)
      // The size options in balancing's order (named first), each toward fewer and toward more checks.
      const sized = new Map(plan.filter((planned) => planned.size !== null).map((one) => [one.key, one]))
      const singles = sizeCandidates(schema)
        .flatMap((option) => sized.get(option.key) ?? [])
        .slice(0, MAX_CANDIDATES)
        .flatMap(({ changes }) =>
          [changes.discovery, changes.complete].flatMap((change, i) =>
            change === undefined ? [] : [{ change, toFewer: i === 0 }],
          ),
        )

      // Standard, each single change over it, then the two profiles at most.
      const total = 1 + singles.length + 2
      let done = 0
      const measure = async (over: readonly OptionChange[], id: ProfileId): Promise<PlayerMeasure> => {
        const yamlText = yamlOf(schema, over, id, '')
        const measured = await deps.measurer.measureDoc({ sessionId: null, game, yamlText, task, priority })
        done++
        task.progress('generate', Math.round((MEASURED_PERCENT * done) / total), { done, total })
        return measured
      }
      task.progress('generate', 0, { done, total })
      const standard = await measure(standardChanges, 'standard')
      if (standard.error !== null) throw errorOf(standard.error)
      const base = standard.checks
      if (base === null) throw new AppError('AP_UNKNOWN', undefined, { detail: 'no count for Standard' })

      const counts = await settleAll(
        singles.map(({ change }) => measure([...standardChanges, change], 'standard')),
      )
      const useful = singles.flatMap(({ change, toFewer }, i) => {
        const { checks, error } = counts[i] ?? { checks: null, error: null }
        if (error !== null) {
          ctx.log.debug('profiles: a size option could not be measured', {
            game,
            key: change.key,
            code: error.code,
          })
        }
        if (checks === null || error !== null) return []
        return (toFewer ? checks < base : checks > base) ? [{ change, toFewer, checks }] : []
      })
      const chosen = aimDiscovery(
        useful.filter((single) => single.toFewer),
        base,
      )
      const raising = new Set(useful.filter((single) => !single.toFewer).map((single) => single.change.key))
      // The changes that are not for the size (death link, difficulty, traps) stay as they are.
      const refined = changesOf(
        plan,
        (planned, id) => planned.size === null || (id === 'discovery' ? chosen : raising).has(planned.key),
      )

      const measures: Partial<Record<ProfileId, PlayerMeasure>> = { standard }
      const others = (['discovery', 'complete'] as const).filter(
        (id) => !isDeepStrictEqual(refined[id], refined.standard),
      )
      const finals = await settleAll(others.map((id) => measure(refined[id], id)))
      others.forEach((id, i) => {
        measures[id] = finals[i]
      })

      const profiles = assemble(game, refined, measures, true)
      await keep(key, profiles)
      task.progress('done', 100)
      return profiles
    },

    async yamlFor(game, profile, playerName) {
      const { key, profiles } = await current(game)
      const changesOf = (id: ProfileId): OptionChange[] | undefined =>
        profiles.profiles.find((one) => one.id === id)?.changes
      return yamlOf(key.schema, changesOf(profile) ?? changesOf('standard') ?? [], profile, playerName)
    },

    async profileYaml(game, profile, playerName) {
      const { key, profiles } = await current(game)
      const made =
        profiles.profiles.find((one) => one.id === profile) ??
        profiles.profiles.find((one) => one.id === 'standard')
      const id = made?.id ?? 'standard'
      const text = yamlOf(key.schema, made?.changes ?? [], id, playerName)
      return { profile: id, measured: profiles.measured, text }
    },

    async cachedCounts(games) {
      const all = [...keptProfiles().values()]
      const byCompactKey = new Map(all.map((entry) => [compactKey(entry.game), entry]))
      const counts = new Map<string, ProfileCounts | null>()
      for (const game of games) {
        const entry = all.find((one) => one.game === game) ?? byCompactKey.get(compactKey(game))
        const holds = entry !== undefined && (await deps.worldVersion(entry.game)) === entry.worldVersion
        counts.set(game, entry && holds ? countsOf(entry) : null)
      }
      return counts
    },
  }
}

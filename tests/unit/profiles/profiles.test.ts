import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasSizeName, sizeCandidates, variantsToward } from '@main/core/checks/balance'
import { createCheckEstimates } from '@main/core/checks/datapackage'
import type { MeasureInput } from '@main/core/checks/measure'
import type { Logger } from '@main/core/logger'
import {
  createProfiles,
  heuristicProfiles,
  type Profiles,
  type ProfilesDeps,
} from '@main/core/profiles/profiles'
import type { TaskHandle } from '@main/core/tasks'
import { loadedWorldVersion } from '@main/core/worlds/world-version'
import { loadYaml11 } from '@main/core/yaml/load'
import { parseTemplate } from '@main/core/yaml/template-parser'
import { validatePlayerDocs, type ValidationContext } from '@main/core/yaml/validate'
import registerCheckHandlers from '@main/ipc/checks'
import registerProfileHandlers from '@main/ipc/profiles'
import { createIpcRegistry } from '@main/ipc/registry'
import { createProfilesService } from '@main/services/profiles.service'
import type { ServiceContainer } from '@main/services/registry'
import { AppError } from '@shared/errors'
import type {
  GameProfile,
  GameProfiles,
  GameSchema,
  OptionSchema,
  PlayerMeasure,
  ProfileId,
  WorldInfo,
} from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'

const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const schemaOf = (game: string): GameSchema =>
  parseTemplate(readFileSync(join(TEMPLATES, `${game}.yaml`), 'utf8'))

const HK = 'Hollow Knight'
const ASH = 'A Short Hike'
const OOT = 'Ocarina of Time'
const SDV = 'Stardew Valley'
const WITNESS = 'The Witness'
const GAMES = [HK, ASH, OOT, SDV, WITNESS]
const PROFILE_IDS: ProfileId[] = ['discovery', 'standard', 'complete']

/** The common options of Hollow Knight, which no profile touches (death link is off by default). */
const HK_COMMON = [
  'progression_balancing',
  'accessibility',
  'DeathLink',
  'local_items',
  'non_local_items',
  'start_inventory',
  'start_hints',
  'start_location_hints',
  'exclude_locations',
  'priority_locations',
  'item_links',
  'plando_items',
]

const optionsOf = (schema: GameSchema): OptionSchema[] => schema.groups.flatMap((group) => group.options)

function profileOf(profiles: GameProfiles, id: ProfileId): GameProfile {
  const profile = profiles.profiles.find((p) => p.id === id)
  if (!profile) throw new Error(`no ${id} profile`)
  return profile
}

/** Option → the value a profile gives it. */
const changesOf = (profiles: GameProfiles, id: ProfileId): Record<string, unknown> =>
  Object.fromEntries(profileOf(profiles, id).changes.map((change) => [change.key, change.to]))

/** `schema` with the default of `key` replaced. */
function withDefault(schema: GameSchema, key: string, value: unknown): GameSchema {
  return {
    ...schema,
    groups: schema.groups.map((group) => ({
      ...group,
      options: group.options.map((option) => (option.key === key ? { ...option, default: value } : option)),
    })),
  }
}

/** `schema` with only the options of `keys`. */
function onlyOptions(schema: GameSchema, keys: string[]): GameSchema {
  return {
    ...schema,
    groups: schema.groups.map((group) => ({
      ...group,
      options: group.options.filter((option) => keys.includes(option.key)),
    })),
  }
}

/** The section of the game of one player YAML, as Archipelago reads it. */
function sectionOf(yamlText: string, game: string): Record<string, unknown> {
  const doc = loadYaml11(yamlText).docs[0] as Record<string, unknown>
  return doc[game] as Record<string, unknown>
}

type Effect = [key: string, value: unknown, delta: number]

/** A fake measurer: `base` checks, plus `delta` for each option the document sets to `value`. */
function fakeMeasurer(base: number, effects: Effect[] = []) {
  const calls: MeasureInput[] = []
  return {
    calls,
    measureDoc: (input: MeasureInput): Promise<PlayerMeasure> => {
      calls.push(input)
      const section = sectionOf(input.yamlText, input.game)
      const checks = effects.reduce(
        (count, [key, value, delta]) => (section[key] === value ? count + delta : count),
        base,
      )
      return Promise.resolve({ checks, range: null, error: null })
    },
  }
}

function taskHandle(): { handle: TaskHandle; stages: string[] } {
  const stages: string[] = []
  return {
    stages,
    handle: {
      id: 't',
      signal: new AbortController().signal,
      progress: (stage) => void stages.push(stage),
      log: () => undefined,
    },
  }
}

let root: string
let core: TestCore
let schemas: Map<string, GameSchema>
let version: string | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat profiles é-'))
  core = createTestContext(root)
  schemas = new Map(GAMES.map((game) => [game, schemaOf(game)]))
  version = '1.0.0'
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

function schema(game: string): GameSchema {
  const found = schemas.get(game)
  if (!found) throw new Error(`no schema ${game}`)
  return found
}

function profilesWith(measurer: ProfilesDeps['measurer']): Profiles {
  return createProfiles(core.ctx, {
    templates: {
      getSchema: (game) => {
        const found = schemas.get(game)
        return found ? Promise.resolve(found) : Promise.reject(new AppError('NOT_FOUND', { game }))
      },
    },
    measurer,
    worldVersion: () => Promise.resolve(version),
  })
}

describe('heuristic profiles', () => {
  it('Standard is the defaults with death_link off', async () => {
    // Death link is off by default: Standard changes nothing.
    const oot = heuristicProfiles(schema(OOT))
    expect(oot.measured).toBe(false)
    expect(profileOf(oot, 'standard')).toEqual({ id: 'standard', changes: [], checks: null, range: null })

    // On by default, it is turned off in all three profiles, however the world spells it.
    const linkOn = withDefault(schema(OOT), 'death_link', true)
    const linked = heuristicProfiles(linkOn)
    expect(profileOf(linked, 'standard').changes).toEqual([{ key: 'death_link', from: true, to: false }])
    for (const id of PROFILE_IDS) {
      expect(profileOf(linked, id).changes, id).toContainEqual({ key: 'death_link', from: true, to: false })
    }
    expect(
      profileOf(heuristicProfiles(withDefault(schema(HK), 'DeathLink', true)), 'standard').changes,
    ).toEqual([{ key: 'DeathLink', from: true, to: false }])

    // Its YAML holds every option at its default, death link off.
    schemas.set(OOT, linkOn)
    const section = sectionOf(await profilesWith(fakeMeasurer(100)).yamlFor(OOT, 'standard', 'Link'), OOT)
    for (const option of optionsOf(linkOn)) {
      expect(section[option.key], option.key).toEqual(option.key === 'death_link' ? false : option.default)
    }
  })

  it('Découverte on Hollow Knight turns size options toward fewer checks and keeps common options', () => {
    const hk = schema(HK)
    const profiles = heuristicProfiles(hk)
    const discovery = profileOf(profiles, 'discovery')
    expect(discovery.checks).toBeNull()
    expect(changesOf(profiles, 'discovery')).toMatchObject({
      RandomizeSkills: false,
      RandomizeCharms: false,
      RandomizeMaskShards: false,
      RandomizeStags: false,
      CostSanityGeoWeight: 0,
    })
    // Each change is one step toward fewer checks, from its default, of an option whose name tells
    // the size.
    const size = new Map(sizeCandidates(hk).map((option) => [option.key, option]))
    for (const change of discovery.changes) {
      const option = size.get(change.key)
      if (!option) throw new Error(`${change.key} is not a size option`)
      expect(hasSizeName(change.key), change.key).toBe(true)
      expect(change.from, change.key).toEqual(option.default)
      expect([change.to], change.key).toEqual(variantsToward(option, option.default, 'fewer'))
    }
    // The numeric ranges that do not say what they count stay: the grubs to hunt, prices, slots.
    for (const key of ['GrubHuntGoal', 'MaximumGeoPrice', 'SlyShopSlots']) {
      expect(changesOf(profiles, 'discovery'), key).not.toHaveProperty(key)
    }
    // What is off already stays so, and no common option moves.
    expect(changesOf(profiles, 'discovery')).not.toHaveProperty('RandomizeGrubs')
    for (const key of HK_COMMON) expect(changesOf(profiles, 'discovery'), key).not.toHaveProperty(key)
  })

  it('Découverte picks the easiest recognised difficulty choice and zeroes traps', () => {
    // Stardew Valley: its trap difficulty is a difficulty whose easiest known choice is `easy`.
    expect(profileOf(heuristicProfiles(schema(SDV)), 'discovery').changes).toContainEqual({
      key: 'trap_difficulty',
      from: 'medium',
      to: 'easy',
    })
    // Ocarina of Time: the ice traps go off; its logic rules have no choice known to be easy.
    const oot = changesOf(heuristicProfiles(schema(OOT)), 'discovery')
    expect(oot.junk_ice_traps).toBe('off')
    expect(oot).not.toHaveProperty('logic_rules')
    // The Witness: a trap percentage goes to 0.
    expect(changesOf(heuristicProfiles(schema(WITNESS)), 'discovery').trap_percentage).toBe(0)
  })

  it('Complet turns size options toward more checks and keeps the default difficulty', () => {
    const hk = schema(HK)
    const profiles = heuristicProfiles(hk)
    expect(changesOf(profiles, 'complete')).toMatchObject({
      RandomizeGrubs: true,
      RandomizeMaps: true,
      Goal: 'hollowknight',
      CostSanity: 'on',
    })
    const size = new Map(sizeCandidates(hk).map((option) => [option.key, option]))
    for (const change of profileOf(profiles, 'complete').changes) {
      const option = size.get(change.key)
      if (!option) throw new Error(`${change.key} is not a size option`)
      expect(hasSizeName(change.key), change.key).toBe(true)
      expect([change.to], change.key).toEqual(variantsToward(option, option.default, 'more'))
    }
    // No price goes up, no starting geo is given.
    for (const key of ['MinimumGrubPrice', 'MaximumGeoPrice', 'StartingGeo']) {
      expect(changesOf(profiles, 'complete'), key).not.toHaveProperty(key)
    }
    // Difficulty and traps stay at their defaults.
    expect(changesOf(heuristicProfiles(schema(SDV)), 'complete')).not.toHaveProperty('trap_difficulty')
    const oot = changesOf(heuristicProfiles(schema(OOT)), 'complete')
    expect(oot).not.toHaveProperty('logic_rules')
    expect(oot).not.toHaveProperty('junk_ice_traps')
    expect(changesOf(heuristicProfiles(schema(WITNESS)), 'complete')).not.toHaveProperty('trap_percentage')
  })

  it('leaves the caps, multipliers and prices of Timespinner and Stardew Valley as they are', () => {
    const untouched: Record<string, string[]> = {
      Timespinner: [
        'hp_cap',
        'aura_cap',
        'level_cap',
        'extra_earrings_xp',
        'shop_multiplier',
        'fixed_drop_rate',
      ],
      [SDV]: [
        'starting_money',
        'profit_margin',
        'experience_multiplier',
        'friendship_multiplier',
        'movement_buff_number',
        'multiple_day_sleep_cost',
        'joja_start_price',
        'joja_end_price',
        'joja_purchases_for_membership',
      ],
    }
    for (const [game, keys] of Object.entries(untouched)) {
      const profiles = heuristicProfiles(game === SDV ? schema(SDV) : schemaOf(game))
      for (const id of ['discovery', 'complete'] as const) {
        for (const key of keys)
          expect(changesOf(profiles, id), `${game} ${id} ${key}`).not.toHaveProperty(key)
      }
    }
    // Their options named after the size are turned still.
    expect(changesOf(heuristicProfiles(schemaOf('Timespinner')), 'complete')).toMatchObject({
      lore_checks: true,
    })
    expect(changesOf(heuristicProfiles(schema(SDV)), 'discovery')).toMatchObject({ quest_locations: 0 })
  })

  it('a profile equal to Standard is left out', async () => {
    // Every size option of this game is at its most already: Complet would be Standard.
    const most = onlyOptions(schema(HK), ['progression_balancing', 'accessibility', 'RandomizeDreamers'])
    expect(heuristicProfiles(most).profiles.map((profile) => profile.id)).toEqual(['discovery', 'standard'])

    // Measured: nothing raises the checks of A Short Hike, so Complet goes.
    const refined = await profilesWith(fakeMeasurer(100, [['goal', 'races', -45]])).refine(
      ASH,
      taskHandle().handle,
    )
    expect(refined.profiles.map((profile) => profile.id)).toEqual(['discovery', 'standard'])
    expect(profileOf(refined, 'discovery')).toMatchObject({
      changes: [{ key: 'goal', from: 'help_everyone', to: 'races' }],
      checks: 55,
    })
  })
})

describe('refined profiles', () => {
  it('refine keeps only changes whose measured effect goes the right way and aims at 50–60 % of Standard for Découverte', async () => {
    const measurer = fakeMeasurer(100, [
      // Alone it would leave 40 %: passed over.
      ['golden_feathers', 0, -60],
      ['goal', 'races', -30],
      ['sticks', 1, -7],
      ['toy_shovels', 1, -4],
      // Not needed once at 59 %.
      ['silver_feathers', 0, -2],
      // No effect, or the wrong way.
      ['buckets', 0, 0],
      ['cost_multiplier', 25, 5],
      ['goal', 'fishmonger', 10],
      ['silver_feathers', 20, 18],
      ['cost_multiplier', 200, -5],
    ])
    const changed = vi.fn()
    core.ctx.bus.on('checks:changed', changed)
    const { handle, stages } = taskHandle()

    expect(await profilesWith(measurer).refine(ASH, handle)).toEqual({
      game: ASH,
      measured: true,
      profiles: [
        {
          id: 'discovery',
          changes: [
            { key: 'goal', from: 'help_everyone', to: 'races' },
            { key: 'sticks', from: 8, to: 1 },
            { key: 'toy_shovels', from: 5, to: 1 },
          ],
          checks: 59,
          range: null,
        },
        { id: 'standard', changes: [], checks: 100, range: null },
        {
          id: 'complete',
          changes: [
            { key: 'goal', from: 'help_everyone', to: 'fishmonger' },
            { key: 'silver_feathers', from: 2, to: 20 },
          ],
          checks: 128,
          range: null,
        },
      ],
    })
    // Standard, the ten single changes of its seven size options, then the two profiles: each player
    // alone, outside any session, within the caller's task.
    expect(measurer.calls).toHaveLength(13)
    for (const call of measurer.calls) {
      expect(call).toMatchObject({ sessionId: null, game: ASH, task: handle, priority: 'background' })
    }
    // Its numeric ranges entered the profiles only once measured: the heuristic ones leave them.
    const heuristic = heuristicProfiles(schema(ASH))
    expect(changesOf(heuristic, 'discovery')).toEqual({ goal: 'races' })
    expect(changesOf(heuristic, 'complete')).toEqual({ goal: 'fishmonger' })
    expect(stages[0]).toBe('prepare')
    expect(stages).toContain('generate')
    expect(stages.at(-1)).toBe('done')
    // The cards' counts changed.
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('measures Standard, the first twelve size options and the profiles that differ from it', async () => {
    const hk = schema(HK)
    const measurer = fakeMeasurer(200)
    const refined = await profilesWith(measurer).refine(HK, taskHandle().handle)

    // Nothing moves the count: both profiles are Standard, measured once.
    expect(refined).toEqual({
      game: HK,
      measured: true,
      profiles: [{ id: 'standard', changes: [], checks: 200, range: null }],
    })
    expect(measurer.calls).toHaveLength(13)
    const defaults = new Map(optionsOf(hk).map((option) => [option.key, option.default]))
    const changedKeys = measurer.calls.slice(1).map((call) => {
      const section = sectionOf(call.yamlText, HK)
      return Object.keys(section).filter(
        (key) => JSON.stringify(section[key]) !== JSON.stringify(defaults.get(key)),
      )
    })
    expect(changedKeys.flat()).toEqual(
      sizeCandidates(hk)
        .slice(0, 12)
        .map((option) => option.key),
    )
  })

  it('a failed measure of Standard fails the refinement; a failed variant is only left out', async () => {
    const failing = (fails: (input: MeasureInput) => boolean) => {
      const measurer = fakeMeasurer(100, [['goal', 'races', -45]])
      return {
        measureDoc: (input: MeasureInput): Promise<PlayerMeasure> =>
          fails(input)
            ? Promise.resolve({
                checks: null,
                range: null,
                error: { code: 'AP_ROM_MISSING', params: { game: ASH } },
              })
            : measurer.measureDoc(input),
      }
    }
    await expect(profilesWith(failing(() => true)).refine(ASH, taskHandle().handle)).rejects.toMatchObject({
      code: 'AP_ROM_MISSING',
      params: { game: ASH },
    })
    // Nothing was kept: the heuristic profiles are still the answer.
    expect((await profilesWith(fakeMeasurer(100)).get(ASH)).measured).toBe(false)

    const refined = await profilesWith(
      failing((input) => sectionOf(input.yamlText, ASH).goal === 'races'),
    ).refine(ASH, taskHandle().handle)
    expect(refined.measured).toBe(true)
    expect(refined.profiles.map((profile) => profile.id)).toEqual(['standard'])
  })

  it('keeps the range of a profile whose YAML rolls dice', async () => {
    const measurer = {
      measureDoc: (): Promise<PlayerMeasure> =>
        Promise.resolve({ checks: 120, range: [110, 130], error: null }),
    }
    const refined = await profilesWith(measurer).refine(SDV, taskHandle().handle)
    expect(profileOf(refined, 'standard')).toMatchObject({ checks: 120, range: [110, 130] })
  })

  it('the cache is reused until the world version or the schema changes', async () => {
    const measurer = fakeMeasurer(100, [['goal', 'races', -45]])
    const profiles = profilesWith(measurer)
    expect(await profiles.get(ASH)).toEqual(heuristicProfiles(schema(ASH)))

    const refined = await profiles.refine(ASH, taskHandle().handle)
    const measured = measurer.calls.length
    expect(await profiles.get(ASH)).toEqual(refined)
    expect(await profiles.refine(ASH, taskHandle().handle)).toEqual(refined)
    expect(measurer.calls).toHaveLength(measured)
    // Kept on disk for the next run, by the file-safe name of the game.
    expect(readdirSync(join(core.platform.paths.dataRoot, 'profiles'))).toEqual([`${ASH}.json`])
    expect(await profilesWith(measurer).get(ASH)).toEqual(refined)

    // Another version of the world: the heuristic profiles again, until it is refined anew.
    version = '1.1.0'
    expect(await profiles.get(ASH)).toEqual(heuristicProfiles(schema(ASH)))
    expect(await profiles.refine(ASH, taskHandle().handle)).toEqual(refined)
    expect(measurer.calls.length).toBeGreaterThan(measured)

    // Another option schema (the templates were generated again): the same.
    schemas.set(ASH, withDefault(schema(ASH), 'cost_multiplier', 150))
    expect(await profiles.get(ASH)).toEqual(heuristicProfiles(schema(ASH)))
  })

  it('a custom world without world_version keeps its refinement until its file is updated', async () => {
    const world = join(root, 'ash.apworld')
    writeFileSync(world, 'v1')
    utimesSync(world, 1_700_000_000, 1_700_000_000)
    const installed: ValidationContext['installedGames'] = new Map([
      [ASH, { worldVersion: null, file: world }],
    ])
    // The service's own: the version of the world Archipelago loads, its file's for this one.
    const profiles = createProfiles(core.ctx, {
      templates: { getSchema: (game) => Promise.resolve(schema(game)) },
      measurer: fakeMeasurer(100, [['goal', 'races', -45]]),
      worldVersion: (game) => loadedWorldVersion(installed, game, '0.6.8'),
    })
    const refined = await profiles.refine(ASH, taskHandle().handle)
    expect(await profiles.get(ASH)).toEqual(refined)
    expect((await profiles.cachedCounts([ASH])).get(ASH)).toMatchObject({ standard: 100 })

    // Updated (the catalog always offers it, its version being unknown): measured anew before it counts.
    writeFileSync(world, 'version 2')
    utimesSync(world, 1_700_000_100, 1_700_000_100)
    expect(await profiles.get(ASH)).toEqual(heuristicProfiles(schema(ASH)))
    expect((await profiles.cachedCounts([ASH])).get(ASH)).toBeNull()
  })

  it('a game without schema is CHECKS_NO_SCHEMA', async () => {
    const profiles = profilesWith(fakeMeasurer(100))
    const noSchema = { code: 'CHECKS_NO_SCHEMA', params: { game: 'Nowhere' } }
    await expect(profiles.get('Nowhere')).rejects.toMatchObject(noSchema)
    await expect(profiles.refine('Nowhere', taskHandle().handle)).rejects.toMatchObject(noSchema)
    await expect(profiles.yamlFor('Nowhere', 'standard', 'Tristan')).rejects.toMatchObject(noSchema)

    // Any other failure to get the schema stays what it is.
    const offline = createProfiles(core.ctx, {
      templates: { getSchema: () => Promise.reject(new AppError('NETWORK_OFFLINE')) },
      measurer: fakeMeasurer(100),
      worldVersion: () => Promise.resolve(null),
    })
    await expect(offline.get(HK)).rejects.toMatchObject({ code: 'NETWORK_OFFLINE' })
  })
})

describe('profile YAMLs', () => {
  const contextFor = (game: string): ValidationContext => ({
    installedGames: new Map([[game, { worldVersion: null }]]),
    apVersion: '0.6.8',
    schemaFor: (name) => (name === game ? schema(game) : undefined),
    allowQuantity: false,
    plandoEnabled: ['bosses', 'connections', 'texts'],
  })

  it('yamlFor writes name, description "ArchipelaGOAT · Découverte", game and a section that validatePlayerDocs accepts', async () => {
    const profiles = profilesWith(fakeMeasurer(100))
    const loaded = loadYaml11(await profiles.yamlFor(HK, 'discovery', 'Tristan'))
    expect(loaded.issues).toEqual([])
    expect(loaded.docs).toHaveLength(1)
    expect(loaded.docs[0]).toMatchObject({
      name: 'Tristan',
      description: 'ArchipelaGOAT · Découverte',
      game: HK,
      requires: { version: '0.6.8' },
      [HK]: { RandomizeSkills: false, RandomizeCharms: false, progression_balancing: 50 },
    })
    expect(validatePlayerDocs(loaded.docs, 'Tristan.yaml', contextFor(HK))).toEqual([
      { index: 0, name: 'Tristan', games: [{ game: HK, weight: 1 }], issues: [] },
    ])

    // Without a player name in the settings, Archipelago numbers the players.
    expect(loadYaml11(await profiles.yamlFor(HK, 'standard', '')).docs[0]).toMatchObject({
      name: 'Player{number}',
      description: 'ArchipelaGOAT · Standard',
    })
    expect(loadYaml11(await profiles.yamlFor(HK, 'complete', 'Tristan')).docs[0]).toMatchObject({
      description: 'ArchipelaGOAT · Complet',
      [HK]: { RandomizeGrubs: true },
    })
  })

  it('every profile of the real templates is a YAML Archipelago accepts', async () => {
    const profiles = profilesWith(fakeMeasurer(100))
    for (const game of GAMES) {
      for (const id of PROFILE_IDS) {
        const loaded = loadYaml11(await profiles.yamlFor(game, id, 'Tristan'))
        const errors = validatePlayerDocs(loaded.docs, 'Tristan.yaml', contextFor(game)).flatMap((doc) =>
          doc.issues.filter((issue) => issue.severity === 'error'),
        )
        expect(errors, `${game} ${id}`).toEqual([])
      }
    }
  })

  it('a profile left out for being Standard writes the Standard options under its own name', async () => {
    const profiles = profilesWith(fakeMeasurer(100, [['goal', 'races', -45]]))
    await profiles.refine(ASH, taskHandle().handle)
    const complete = loadYaml11(await profiles.yamlFor(ASH, 'complete', 'Tristan')).docs[0]
    const standard = loadYaml11(await profiles.yamlFor(ASH, 'standard', 'Tristan')).docs[0]
    expect(complete).toEqual({ ...(standard as object), description: 'ArchipelaGOAT · Complet' })
    // A refined Découverte writes its measured changes.
    expect(sectionOf(await profiles.yamlFor(ASH, 'discovery', 'Tristan'), ASH)).toMatchObject({
      goal: 'races',
      sticks: 8,
    })
  })
})

describe('profile counts', () => {
  const meta = { senderId: 1 }

  /** A service container holding only `services`. */
  const containerOf = (services: Record<string, unknown>): ServiceContainer =>
    ({
      ctx: core.ctx,
      get: (name: string) => services[name],
      startEager: () => undefined,
    }) as unknown as ServiceContainer

  it('checks:estimate returns the profile counts once refined', async () => {
    const profiles = profilesWith(
      fakeMeasurer(100, [
        ['goal', 'races', -45],
        ['silver_feathers', 20, 18],
      ]),
    )
    const ipc = createIpcRegistry()
    registerCheckHandlers(
      ipc.registerHandler,
      containerOf({ checks: { estimates: createCheckEstimates(core.ctx) }, profiles }),
    )
    const estimate = (games: string[]) => ipc.dispatch('checks:estimate', { games }, meta)

    expect(await estimate([ASH])).toEqual({ ok: true, value: { [ASH]: { max: null, profiles: null } } })
    await profiles.refine(ASH, taskHandle().handle)
    const counts = { discovery: 55, standard: 100, complete: 118 }
    expect(await estimate([ASH, 'A short hike!', HK, 'constructor'])).toEqual({
      ok: true,
      value: {
        [ASH]: { max: null, profiles: counts },
        // A name that differs only in case and punctuation is the same game.
        'A short hike!': { max: null, profiles: counts },
        [HK]: { max: null, profiles: null },
        constructor: { max: null, profiles: null },
      },
    })

    // Another version of the world: no counts until it is refined anew.
    version = '2.0.0'
    expect(await estimate([ASH])).toEqual({ ok: true, value: { [ASH]: { max: null, profiles: null } } })
  })

  it('checks:estimate keeps the most checks of a game when the profile counts cannot be read', async () => {
    const estimates = {
      maxFor: (game: string) => (game === HK ? 740 : null),
      refresh: () => Promise.resolve(),
    }
    const failing = { cachedCounts: () => Promise.reject(new AppError('AP_UNKNOWN')) }
    const ipc = createIpcRegistry()
    registerCheckHandlers(ipc.registerHandler, containerOf({ checks: { estimates }, profiles: failing }))
    expect(await ipc.dispatch('checks:estimate', { games: [HK] }, meta)).toEqual({
      ok: true,
      value: { [HK]: { max: 740, profiles: null } },
    })

    // The same when the version of a refined game's world cannot be told (the worlds scan failed).
    let scanFails = false
    const profiles = createProfiles(core.ctx, {
      templates: { getSchema: (game) => Promise.resolve(schema(game)) },
      measurer: fakeMeasurer(100, [['goal', 'races', -45]]),
      worldVersion: () => (scanFails ? Promise.reject(new Error('EPERM')) : Promise.resolve('1.0.0')),
    })
    await profiles.refine(ASH, taskHandle().handle)
    scanFails = true
    const other = createIpcRegistry()
    registerCheckHandlers(other.registerHandler, containerOf({ checks: { estimates }, profiles }))
    expect(await other.dispatch('checks:estimate', { games: [HK, ASH] }, meta)).toEqual({
      ok: true,
      value: { [HK]: { max: 740, profiles: null }, [ASH]: { max: null, profiles: null } },
    })
  })

  it('profiles:get answers the profiles of a game and checks its name', async () => {
    const profiles = profilesWith(fakeMeasurer(100))
    const ipc = createIpcRegistry()
    registerProfileHandlers(ipc.registerHandler, containerOf({ profiles }))
    expect(await ipc.dispatch('profiles:get', { game: ASH }, meta)).toEqual({
      ok: true,
      value: heuristicProfiles(schema(ASH)),
    })
    expect(await ipc.dispatch('profiles:get', { game: '' }, meta)).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(await ipc.dispatch('profiles:get', { game: 'Nowhere' }, meta)).toMatchObject({
      error: { code: 'CHECKS_NO_SCHEMA' },
    })
  })
})

describe('the profiles service', () => {
  /** A world as the inventory lists it. */
  const world = (game: string, location: WorldInfo['location'], worldVersion: string | null): WorldInfo => ({
    id: `${location}:${game}`,
    fileName: `${game}.apworld`,
    path: `/worlds/${game}.apworld`,
    location,
    module: game.toLowerCase().replace(/\W/g, '_'),
    game,
    manifest:
      worldVersion === null
        ? null
        : {
            game,
            worldVersion,
            minimumApVersion: null,
            maximumApVersion: null,
            authors: [],
            version: 7,
            compatibleVersion: 7,
          },
    states: ['ok'],
    sizeBytes: 1,
  })

  function serviceWith(opts: { worlds: () => WorldInfo[]; installed: string[]; measured?: string[] }) {
    const refine = vi.fn((game: string, task: TaskHandle) => {
      task.progress('done', 100)
      return Promise.resolve<GameProfiles>({ game, profiles: [], measured: true })
    })
    const get = vi.fn((game: string) =>
      Promise.resolve<GameProfiles>({ game, profiles: [], measured: opts.measured?.includes(game) ?? false }),
    )
    const kinds: string[] = []
    core.ctx.bus.on('task:progress', ({ kind }) => kinds.push(kind))
    const service = createProfilesService(core.ctx, {
      profiles: {
        get,
        refine,
        yamlFor: () => Promise.resolve(''),
        cachedCounts: () => Promise.resolve(new Map()),
      },
      worlds: { list: () => Promise.resolve(opts.worlds()) },
      worldVersion: (game) => Promise.resolve(opts.installed.includes(game) ? '1.0.0' : null),
    })
    return { service, refine, kinds }
  }

  it('refines in the background, as a profiles task, a world installed after the window opened', async () => {
    let worlds = [world(HK, 'custom', '1.0.0'), world('Clique', 'core', null)]
    const { refine, kinds } = serviceWith({ worlds: () => worlds, installed: [HK, ASH, 'Clique'] })
    core.lifecycle.windowReady()

    // A new world, another version of one, and a core world (Archipelago installed again).
    worlds = [
      world(HK, 'custom', '1.1.0'),
      world(ASH, 'custom', null),
      world('Clique', 'core', null),
      world('Blasphemous', 'core', null),
    ]
    core.ctx.bus.emit('worlds:changed', null)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(2))
    expect(refine.mock.calls.map(([game]) => game).sort()).toEqual([ASH, HK])
    expect(kinds).toContain('profiles')
    expect(kinds).not.toContain('measure')

    // Nothing new: nothing refined.
    core.ctx.bus.emit('worlds:changed', null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).toHaveBeenCalledTimes(2)
  })

  it('refines again a custom world without world_version once its file is updated', async () => {
    const file = join(root, 'ash.apworld')
    writeFileSync(file, 'v1')
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    const { refine } = serviceWith({
      worlds: () => [{ ...world(ASH, 'custom', null), path: file }],
      installed: [ASH],
    })
    core.lifecycle.windowReady()

    // The same file: nothing to refine.
    core.ctx.bus.emit('worlds:changed', null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).not.toHaveBeenCalled()

    writeFileSync(file, 'version 2')
    utimesSync(file, 1_700_000_100, 1_700_000_100)
    core.ctx.bus.emit('worlds:changed', null)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(refine.mock.calls[0]?.[0]).toBe(ASH)
  })

  it('takes the worlds a change finds before the window opened as already there', async () => {
    let worlds = [world(HK, 'custom', '1.0.0')]
    const { refine } = serviceWith({ worlds: () => worlds, installed: [HK, ASH] })
    core.ctx.bus.emit('worlds:changed', null)
    worlds = [world(HK, 'custom', '1.0.0'), world(ASH, 'custom', '1.0.0')]
    core.ctx.bus.emit('worlds:changed', null)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(refine.mock.calls[0]?.[0]).toBe(ASH)
  })

  it('refines a game again once its running refinement ends, when its world changed meanwhile', async () => {
    let worlds = [world(HK, 'custom', '1.0.0')]
    const { refine } = serviceWith({ worlds: () => worlds, installed: [HK] })
    let release = (): void => undefined
    refine.mockImplementationOnce(
      (game) =>
        new Promise<GameProfiles>((resolve) => {
          release = () => resolve({ game, profiles: [], measured: true })
        }),
    )
    core.lifecycle.windowReady()
    worlds = [world(HK, 'custom', '1.1.0')]
    core.ctx.bus.emit('worlds:changed', null)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))

    worlds = [world(HK, 'custom', '1.2.0')]
    core.ctx.bus.emit('worlds:changed', null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(2))
  })

  it('refines one game at a time', async () => {
    let worlds = [world(HK, 'custom', '1.0.0')]
    const { refine } = serviceWith({ worlds: () => worlds, installed: [HK, ASH, 'Timespinner'] })
    const releases: (() => void)[] = []
    refine.mockImplementation(
      (game) =>
        new Promise<GameProfiles>((resolve) => {
          releases.push(() => resolve({ game, profiles: [], measured: true }))
        }),
    )
    const refining = () => core.ctx.tasks.list().filter((task) => task.kind === 'profiles').length
    core.lifecycle.windowReady()
    worlds = [world(HK, 'custom', '1.1.0'), world(ASH, 'custom', null), world('Timespinner', 'custom', null)]
    core.ctx.bus.emit('worlds:changed', null)

    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).toHaveBeenCalledTimes(1)
    expect(refining()).toBe(1)
    releases.shift()?.()
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(2))
    expect(refining()).toBe(1)
    releases.shift()?.()
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(3))
    releases.shift()?.()
    await vi.waitFor(() => expect(refining()).toBe(0))
    expect(refine.mock.calls.map(([game]) => game)).toEqual([HK, ASH, 'Timespinner'])
  })

  it('tries a game without a template again once the templates are generated, or when asked again', async () => {
    let worlds: WorldInfo[] = []
    const { service, refine } = serviceWith({ worlds: () => worlds, installed: [HK] })
    refine.mockRejectedValueOnce(new AppError('CHECKS_NO_SCHEMA', { game: HK }))
    refine.mockRejectedValueOnce(new AppError('CHECKS_NO_SCHEMA', { game: HK }))
    refine.mockRejectedValueOnce(new AppError('CHECKS_NO_SCHEMA', { game: HK }))
    core.lifecycle.windowReady()

    // Installed: no template yet, so its refinement fails.
    worlds = [world(HK, 'custom', '1.0.0')]
    core.ctx.bus.emit('worlds:changed', null)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    // Asked again, it is tried again (it did not stay asked).
    await service.get(HK)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A templates task that ends tries it again.
    core.ctx.bus.emit('task:done', { taskId: 't1', kind: 'templates', result: { count: 1 } })
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // So does a « Jeu prêt », which generates them within its own task.
    core.ctx.bus.emit('task:done', { taskId: 'r1', kind: 'ready', result: null })
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(4))
    // Refined now: another templates task tries nothing more.
    await new Promise((resolve) => setTimeout(resolve, 20))
    core.ctx.bus.emit('task:done', { taskId: 't2', kind: 'templates', result: { count: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).toHaveBeenCalledTimes(4)
  })

  it('counts a game as asked only once its world is known to be installed', async () => {
    const installed: string[] = []
    const { service, refine } = serviceWith({ worlds: () => [], installed })
    await service.get(ASH)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).not.toHaveBeenCalled()

    // Installed since: asking again refines it.
    installed.push(ASH)
    await service.get(ASH)
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
  })

  it('answers get at once and refines an installed game once in the background', async () => {
    const { service, refine } = serviceWith({ worlds: () => [], installed: [HK, ASH], measured: [ASH] })
    expect(await service.get(HK)).toEqual({ game: HK, profiles: [], measured: false })
    await vi.waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(refine.mock.calls[0]?.[0]).toBe(HK)

    // Asked again, a game is not refined again in this run; one not installed, or measured, never.
    await service.get(HK)
    await service.get('Not installed')
    await service.get(ASH)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refine).toHaveBeenCalledTimes(1)
  })

  it('logs a background refinement that fails, without failing anything else', async () => {
    const warn = vi.fn<Logger['warn']>()
    core.ctx.log = { ...core.ctx.log, warn }
    const { service, refine } = serviceWith({ worlds: () => [], installed: [HK] })
    refine.mockRejectedValueOnce(new AppError('AP_ROM_MISSING', { game: HK }))
    const failed = new Promise((resolve) => core.ctx.bus.on('task:failed', resolve))
    await service.get(HK)
    expect(await failed).toMatchObject({ kind: 'profiles', error: { code: 'AP_ROM_MISSING' } })
    expect(warn).toHaveBeenCalledWith('profiles: refinement failed', expect.objectContaining({ game: HK }))
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createBalancer,
  proposeBalance,
  rewriteOptions,
  sizeCandidates,
  variantsToward,
  type Balancer,
  type BalancerDeps,
} from '@main/core/checks/balance'
import type { MeasureInput } from '@main/core/checks/measure'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import { buildValidationContext, type ValidationContextDeps } from '@main/core/sessions/validate-session'
import type { TaskHandle } from '@main/core/tasks'
import { parseTemplate } from '@main/core/yaml/template-parser'
import { parsePlayerYaml } from '@main/core/yaml/writer'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { isOffTarget, measuredCounts, targetOf } from '@shared/checks'
import { AppError } from '@shared/errors'
import { docFromSchema } from '@shared/studio-model'
import type { ApInstall, ApPaths, EditorDoc, GameSchema, PlayerChecks, SessionChecks } from '@shared/types'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'

const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const schemaOf = (game: string): GameSchema =>
  parseTemplate(readFileSync(join(TEMPLATES, `${game}.yaml`), 'utf8'))

const HK = 'Hollow Knight'
const ASH = 'A Short Hike'
const OOT = 'Ocarina of Time'
const SDV = 'Stardew Valley'

const optionsOf = (schema: GameSchema) => schema.groups.flatMap((group) => group.options)
const optionOf = (schema: GameSchema, key: string) => {
  const option = optionsOf(schema).find((o) => o.key === key)
  if (!option) throw new Error(`no option ${key}`)
  return option
}

/** The value a doc gives an option: its own, else the option's default. */
function valueIn(doc: EditorDoc, schema: GameSchema, key: string): unknown {
  const set = doc.options[key]
  return set?.mode === 'value' ? set.value : optionOf(schema, key).default
}

/** A fake measure: `base` checks, plus `delta` for each option at the value `when`. */
function countModel(
  schema: GameSchema,
  base: number,
  effects: Record<string, [when: unknown, delta: number]>,
) {
  return (doc: EditorDoc): number =>
    Object.entries(effects).reduce(
      (count, [key, [when, delta]]) => (valueIn(doc, schema, key) === when ? count + delta : count),
      base,
    )
}

/** The options `doc` gives another value than `from`. */
const changedKeys = (schema: GameSchema, from: EditorDoc, doc: EditorDoc): string[] =>
  optionsOf(schema)
    .map((option) => option.key)
    .filter((key) => JSON.stringify(valueIn(doc, schema, key)) !== JSON.stringify(valueIn(from, schema, key)))

const row = (over: Partial<PlayerChecks>): PlayerChecks => ({
  fileId: 'f_1',
  docIndex: 0,
  name: 'P',
  game: HK,
  checks: 100,
  range: null,
  source: 'measure',
  error: null,
  ...over,
})

describe('targetOf and isOffTarget', () => {
  it('targetOf: median, short 0.6x, long 1.5x, count', () => {
    expect(targetOf([400, 131, 203], { kind: 'median' })).toBe(203)
    expect(targetOf([400, 131, 203], { kind: 'short' })).toBe(122)
    expect(targetOf([400, 131, 203], { kind: 'long' })).toBe(305)
    expect(targetOf([400, 131, 203], { kind: 'count', value: 250 })).toBe(250)
    // An even count of players: the middle of the two middle counts.
    expect(targetOf([100, 400, 200, 300], { kind: 'median' })).toBe(250)
    expect(targetOf([], { kind: 'count', value: 90 })).toBe(90)
  })

  it('isOffTarget at ±25 %', () => {
    expect(isOffTarget(126, 100)).toBe(true)
    expect(isOffTarget(125, 100)).toBe(false)
    expect(isOffTarget(75, 100)).toBe(false)
    expect(isOffTarget(74, 100)).toBe(true)
  })

  it('takes the target from measured and generated counts, never from an estimate', () => {
    expect(
      measuredCounts([
        row({ checks: 131 }),
        row({ checks: 203, source: 'generation' }),
        row({ checks: 740, source: 'estimate' }),
        row({ checks: null, error: { code: 'AP_WORLD_NOT_FOUND' } }),
      ]),
    ).toEqual([131, 203])
  })
})

describe('sizeCandidates', () => {
  it('sizeCandidates of the real Hollow Knight template lists its RandomizeX toggles and leaves out the common options', () => {
    const schema = schemaOf(HK)
    const keys = sizeCandidates(schema).map((option) => option.key)
    const randomize = optionsOf(schema)
      .map((option) => option.key)
      .filter((key) => key.startsWith('Randomize'))
    expect(randomize.length).toBeGreaterThan(20)
    // The options named after the size come first, in the template's order, then the numeric ranges.
    expect(keys.slice(0, randomize.length)).toEqual(randomize)
    expect(keys).toEqual(
      expect.arrayContaining(['Goal', 'AddUnshuffledLocations', 'CostSanity', 'SlyShopSlots']),
    )
    for (const common of [
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
    ]) {
      expect(keys, common).not.toContain(common)
    }
    // Neither a logic toggle nor a dict says anything of the size.
    expect(keys).not.toContain('PreciseMovement')
    expect(keys).not.toContain('PlandoCharmCosts')
  })

  it('finds the size options of Ocarina of Time, Stardew Valley and A Short Hike by their names and kinds', () => {
    const oot = sizeCandidates(schemaOf(OOT)).map((option) => option.key)
    expect(oot).toEqual(
      expect.arrayContaining(['shuffle_cows', 'shopsanity', 'tokensanity', 'chicken_count', 'trials']),
    )
    expect(oot).not.toContain('death_link')
    expect(oot).not.toContain('plando_connections')
    expect(oot).not.toContain('logic_tricks')

    const sdv = sizeCandidates(schemaOf(SDV)).map((option) => option.key)
    expect(sdv).toEqual(
      expect.arrayContaining([
        'goal',
        'cropsanity',
        'festival_locations',
        'quest_locations',
        'exclude_ginger_island',
        'include_endgame_locations',
      ]),
    )
    // A list cannot be stepped toward fewer or more.
    expect(sdv).not.toContain('chefsanity')
    expect(sdv).not.toContain('death_link')

    const ash = sizeCandidates(schemaOf(ASH)).map((option) => option.key)
    expect(ash).toEqual(expect.arrayContaining(['goal', 'golden_feathers', 'cost_multiplier']))
    expect(ash).not.toContain('coins_in_shops')
    expect(ash).not.toContain('progression_balancing')
  })
})

describe('variantsToward', () => {
  it('variantsToward a toggle, a choice and a range', () => {
    const hk = schemaOf(HK)
    const oot = schemaOf(OOT)
    const sdv = schemaOf(SDV)

    // A toggle: on for more, off for fewer; an exclude_ toggle the other way round.
    const charms = optionOf(hk, 'RandomizeCharms')
    expect(variantsToward(charms, true, 'fewer')).toEqual([false])
    expect(variantsToward(charms, true, 'more')).toEqual([])
    expect(variantsToward(charms, 'off', 'more')).toEqual([true])
    expect(variantsToward(charms, 'random', 'more')).toEqual([])
    const ginger = optionOf(sdv, 'exclude_ginger_island')
    expect(variantsToward(ginger, false, 'fewer')).toEqual([true])
    expect(variantsToward(ginger, false, 'more')).toEqual([])

    // A choice: the next one for more, the previous one for fewer.
    const tokens = optionOf(oot, 'tokensanity')
    expect(tokens.choices).toEqual(['off', 'dungeons', 'overworld', 'all'])
    expect(variantsToward(tokens, 'dungeons', 'more')).toEqual(['overworld'])
    expect(variantsToward(tokens, 'Dungeons', 'fewer')).toEqual(['off'])
    expect(variantsToward(tokens, 'off', 'fewer')).toEqual([])
    expect(variantsToward(tokens, 'all', 'more')).toEqual([])
    expect(variantsToward(tokens, 'random', 'more')).toEqual([])
    // An option id: where it stands among the choices is not known.
    expect(variantsToward(tokens, 1, 'more')).toEqual([])
    // `off` read as a boolean, as PyYAML does: still the choice `off`.
    expect(variantsToward(optionOf(hk, 'CostSanity'), false, 'more')).toEqual(['on'])

    // A range: its bound.
    const slots = optionOf(hk, 'SlyShopSlots')
    expect(slots.range).toEqual({ min: 0, max: 16 })
    expect(variantsToward(slots, 8, 'more')).toEqual([16])
    expect(variantsToward(slots, '8', 'fewer')).toEqual([0])
    expect(variantsToward(slots, 16, 'more')).toEqual([])
    expect(variantsToward(slots, 'random-high', 'more')).toEqual([])
    // A named range: its special names count as their numbers.
    const quests = optionOf(sdv, 'quest_locations')
    expect(variantsToward(quests, 'normal', 'more')).toEqual([56])
    expect(variantsToward(quests, 'none', 'fewer')).toEqual([])
    // Nothing to step in a list.
    expect(variantsToward(optionOf(oot, 'logic_tricks'), [], 'more')).toEqual([])
  })
})

describe('proposeBalance', () => {
  it('proposeBalance with a fake measurer reaches the target with at most 3 changes', async () => {
    const hk = schemaOf(HK)
    const doc = docFromSchema(hk, 'Knight')
    const model = countModel(hk, 200, {
      RandomizeSkills: [false, -60],
      RandomizeCharms: [false, -45],
      RandomizeKeys: [false, -12],
      RandomizeStags: [false, -8],
    })
    const measure = vi.fn((variant: EditorDoc) => Promise.resolve<number | null>(model(variant)))

    const proposals = await proposeBalance({ schema: hk, doc, current: model(doc), target: 120, measure })

    // The greedy combination (verified by a measure), then the best single changes.
    expect(proposals.map((p) => p.checks)).toEqual([120, 140, 155])
    const [combined, skills] = proposals
    expect(combined?.changes).toEqual([
      { key: 'RandomizeSkills', from: true, to: false },
      { key: 'RandomizeKeys', from: true, to: false },
      { key: 'RandomizeStags', from: true, to: false },
    ])
    expect(combined?.diff).toBe(
      [
        '-  RandomizeSkills: true',
        '+  RandomizeSkills: false',
        '-  RandomizeKeys: true',
        '+  RandomizeKeys: false',
        '-  RandomizeStags: true',
        '+  RandomizeStags: false',
      ].join('\n'),
    )
    expect(skills?.changes).toEqual([{ key: 'RandomizeSkills', from: true, to: false }])
    expect(new Set(proposals.map((p) => p.id)).size).toBe(3)
    // The combination is measured as a whole, once.
    expect(measure.mock.calls.filter(([variant]) => changedKeys(hk, doc, variant).length === 3)).toHaveLength(
      1,
    )
    // The doc given is never changed.
    expect(doc).toEqual(docFromSchema(hk, 'Knight'))
  })

  it('turns options toward more checks for a player below the target, an option left out included', async () => {
    const oot = schemaOf(OOT)
    const doc: EditorDoc = {
      ...docFromSchema(oot, 'Link'),
      options: { tokensanity: { mode: 'value', value: 'off' } },
    }
    const model = countModel(oot, 300, {
      tokensanity: ['dungeons', 50],
      shuffle_grotto_entrances: [true, 30],
    })

    const proposals = await proposeBalance({
      schema: oot,
      doc,
      current: 300,
      target: 380,
      measure: (variant) => Promise.resolve(model(variant)),
    })

    expect(proposals[0]).toMatchObject({
      checks: 380,
      changes: [
        { key: 'tokensanity', from: 'off', to: 'dungeons' },
        { key: 'shuffle_grotto_entrances', from: false, to: true },
      ],
    })
    // An option the doc leaves at its default is written in.
    expect(proposals[0]?.diff).toBe(
      ['-  tokensanity: "off"', '+  tokensanity: dungeons', '+  shuffle_grotto_entrances: true'].join('\n'),
    )
  })

  it('measures at most 12 single variants', async () => {
    const hk = schemaOf(HK)
    const doc = docFromSchema(hk, 'Knight')
    const randomizeOff = optionsOf(hk).filter((o) => o.key.startsWith('Randomize') && o.default === false)
    expect(randomizeOff.length).toBeGreaterThan(12)
    const model = countModel(
      hk,
      100,
      Object.fromEntries(randomizeOff.map((option): [string, [boolean, number]] => [option.key, [true, 5]])),
    )
    const measured: EditorDoc[] = []
    const measure = (variant: EditorDoc): Promise<number | null> => {
      measured.push(variant)
      return Promise.resolve(model(variant))
    }

    const proposals = await proposeBalance({ schema: hk, doc, current: 100, target: 400, measure })

    expect(measured.filter((variant) => changedKeys(hk, doc, variant).length === 1)).toHaveLength(12)
    // And the one combination of three changes.
    expect(measured).toHaveLength(13)
    expect(proposals.map((p) => [p.changes.length, p.checks])).toEqual([
      [3, 115],
      [1, 105],
      [1, 105],
    ])
  })

  it('returns [] when no option changes the count', async () => {
    const ash = schemaOf(ASH)
    const doc = docFromSchema(ash, 'Claire')
    const measure = vi.fn<(variant: EditorDoc) => Promise<number | null>>(() => Promise.resolve(131))
    expect(await proposeBalance({ schema: ash, doc, current: 131, target: 200, measure })).toEqual([])
    expect(measure).toHaveBeenCalled()

    // A player on the target: nothing is measured.
    measure.mockClear()
    expect(await proposeBalance({ schema: ash, doc, current: 131, target: 131, measure })).toEqual([])
    expect(measure).not.toHaveBeenCalled()

    // Failed measures and changes that go past the target farther than it is now are no proposals.
    measure.mockResolvedValue(null)
    expect(await proposeBalance({ schema: ash, doc, current: 131, target: 100, measure })).toEqual([])
    measure.mockResolvedValue(10)
    expect(await proposeBalance({ schema: ash, doc, current: 131, target: 100, measure })).toEqual([])
  })

  it('leaves the real dice of a player alone', async () => {
    const ash = schemaOf(ASH)
    const dice: EditorDoc['options'] = {
      goal: { mode: 'weighted', weights: { races: 50, help_everyone: 50 } },
      golden_feathers: { mode: 'raw', yaml: '10: 50\n20: 50' },
      silver_feathers: { mode: 'raw', yaml: '2: 0\nrandom-low: 50' },
    }
    const doc: EditorDoc = { ...docFromSchema(ash, 'Claire'), options: dice }
    const model = countModel(ash, 131, { buckets: [0, -10] })
    const measured: EditorDoc[] = []

    const proposals = await proposeBalance({
      schema: ash,
      doc,
      current: 131,
      target: 100,
      measure: (variant) => {
        measured.push(variant)
        return Promise.resolve(model(variant))
      },
    })

    expect(measured.length).toBeGreaterThan(0)
    for (const variant of measured) {
      for (const [key, value] of Object.entries(dice)) expect(variant.options[key], key).toEqual(value)
    }
    expect(proposals.map((p) => p.changes)).toEqual([[{ key: 'buckets', from: 2, to: 0 }]])
  })

  it('stops with the error of a measure that rejects (a cancelled task)', async () => {
    const ash = schemaOf(ASH)
    const measure = (): Promise<number | null> => Promise.reject(new AppError('TASK_CANCELLED'))
    await expect(
      proposeBalance({ schema: ash, doc: docFromSchema(ash, 'Claire'), current: 131, target: 50, measure }),
    ).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
  })
})

// --- applying a proposal ------------------------------------------------------------------------------

const install: ApInstall = {
  kind: 'custom',
  version: '0.6.8',
  root: 'C:\\AP',
  appImagePath: null,
  paths: {} as ApPaths,
}

const CLAIRE = `# Two players in one file
name: Claire
game: ${ASH}
${ASH}:
  goal: nap # the short one
`
const KNIGHT = `# The knight
name: Knight
game: ${HK}
requires:
  version: 0.6.8
${HK}:
  # what is shuffled
  RandomizeSkills: true # the skills
  RandomizeCharms: true

  StartingGeo: 0
`
const FILE = `${CLAIRE}---\n${KNIGHT}`

describe('checks:suggest and checks:apply', () => {
  let root: string
  let core: TestCore
  let store: SessionStore
  let balancer: Balancer
  let clock: number
  let measured: MeasureInput[]
  let measureFails: boolean
  let last: SessionChecks | null
  const hk = schemaOf(HK)
  const ash = schemaOf(ASH)
  const models: Record<string, (doc: EditorDoc) => number> = {
    [HK]: countModel(hk, 200, { RandomizeSkills: [false, -40], RandomizeKeys: [false, -20] }),
    [ASH]: countModel(ash, 131, { goal: ['races', -31], golden_feathers: [0, -5] }),
  }

  const task = (): { handle: TaskHandle; stages: string[] } => {
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

  function deps(): BalancerDeps {
    return {
      templates: {
        getSchema: (game) =>
          game === HK || game === ASH
            ? Promise.resolve(game === HK ? hk : ash)
            : Promise.reject(new AppError('NOT_FOUND', { game })),
      },
      measurer: {
        measureDoc: (input) => {
          measured.push(input)
          if (measureFails)
            return Promise.resolve({ checks: null, range: null, error: { code: 'AP_ROM_MISSING' } })
          const { docs } = parsePlayerYaml(input.yamlText)
          const model = models[input.game]
          if (docs.length !== 1 || !docs[0] || !model)
            throw new Error('one document of a known game expected')
          return Promise.resolve({ checks: model(docs[0]), range: null, error: null })
        },
        lastSession: () => Promise.resolve(last),
      },
      sessions: store,
      now: () => clock,
    }
  }

  async function sessionWithFile(text = FILE): Promise<{ id: string; fileId: string }> {
    const { id } = await store.create('Soirée')
    const session = await store.addText(id, 'players.yaml', text)
    const fileId = session.players[0]?.id
    if (!fileId) throw new Error('no file')
    return { id, fileId }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat balance é-'))
    core = createTestContext(root)
    const context: ValidationContextDeps = {
      locator: { detect: () => Promise.resolve(install) },
      worlds: {
        installedGames: () =>
          Promise.resolve(new Map([ASH, HK].map((game) => [game, { worldVersion: null }] as const))),
      },
      templates: { getSchema: (game) => Promise.reject(new AppError('NOT_FOUND', { game })) },
      settings: { get: () => Promise.resolve(undefined) },
      log: silentLogger,
    }
    store = createSessionStore(core.ctx, {
      validationContext: (games, plando) => buildValidationContext(context, games, plando),
    })
    clock = Date.parse('2026-10-18T12:00:00Z')
    measured = []
    measureFails = false
    last = {
      measuredAt: '2026-10-18T11:00:00Z',
      players: [row({ docIndex: 0, game: ASH, checks: 100 }), row({ docIndex: 1, checks: 200 })],
    }
    balancer = createBalancer(core.ctx, deps())
  })

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

  it('checks:apply rewrites only the changed options, keeps comments, and replaces the session file', async () => {
    const { id, fileId } = await sessionWithFile()
    const { handle, stages } = task()

    const proposals = await balancer.suggest(
      { sessionId: id, fileId, docIndex: 1, target: { kind: 'count', value: 140 } },
      handle,
    )

    expect(proposals[0]).toMatchObject({
      checks: 140,
      changes: [
        { key: 'RandomizeSkills', from: true, to: false },
        { key: 'RandomizeKeys', from: true, to: false },
      ],
    })
    // The file's own lines, as apply writes them.
    expect(proposals[0]?.diff).toBe(
      [
        '-  RandomizeSkills: true # the skills',
        '+  RandomizeSkills: false # the skills',
        '+  RandomizeKeys: false',
      ].join('\n'),
    )
    expect(stages[0]).toBe('prepare')
    expect(stages).toContain('generate')
    expect(stages.at(-1)).toBe('done')
    // Each measure is the player's document alone, with the session's rules.
    expect(measured.length).toBeGreaterThan(1)
    for (const input of measured) {
      expect(input).toMatchObject({ sessionId: id, game: HK, task: handle })
      expect(parsePlayerYaml(input.yamlText).docs).toHaveLength(1)
    }

    const session = await balancer.apply({ sessionId: id, fileId, proposalId: proposals[0]?.id ?? '' })

    const { text } = await store.readFile(id, fileId)
    expect(text).toBe(
      FILE.replace('RandomizeSkills: true # the skills', 'RandomizeSkills: false # the skills').replace(
        '  StartingGeo: 0\n',
        '  StartingGeo: 0\n  RandomizeKeys: false\n',
      ),
    )
    // Validated again by the store.
    expect(session.players[0]?.docs.map((doc) => doc.name)).toEqual(['Claire', 'Knight'])
  })

  it('balances a document written the template way, moving the weights and keeping the comments', async () => {
    const template = readFileSync(join(TEMPLATES, `${ASH}.yaml`), 'utf8')
    const { id, fileId } = await sessionWithFile(template)

    const proposals = await balancer.suggest(
      { sessionId: id, fileId, docIndex: 0, target: { kind: 'count', value: 95 } },
      task().handle,
    )

    expect(proposals.map((p) => p.checks)).toEqual([95, 100, 126])
    expect(proposals[0]?.changes).toEqual([
      { key: 'goal', from: 'help_everyone', to: 'races' },
      { key: 'golden_feathers', from: 20, to: 0 },
    ])
    expect(proposals[0]?.diff).toBe(
      [
        '-    races: 0',
        '-    help_everyone: 50',
        '+    races: 50',
        '+    help_everyone: 0',
        '-    20: 50',
        '+    20: 0',
        '+    0: 50',
      ].join('\n'),
    )

    await balancer.apply({ sessionId: id, fileId, proposalId: proposals[0]?.id ?? '' })

    // The weight goes from the old choice to the new one (0 is added after the last choice of
    // golden_feathers); every comment of the template stays.
    const golden = template.indexOf('  golden_feathers:')
    const expected =
      template
        .slice(0, golden)
        .replace('    races: 0\n    help_everyone: 50\n', '    races: 50\n    help_everyone: 0\n') +
      template
        .slice(golden)
        .replace('    20: 50\n', '    20: 0\n')
        .replace(
          '    random-range-0-20: 0 # random value between 0 and 20\n',
          '    random-range-0-20: 0 # random value between 0 and 20\n    0: 50\n',
        )
    const { text } = await store.readFile(id, fileId)
    expect(text).toBe(expected.replace(/^\uFEFF/, ''))
  })

  it('shows in the diff the comments a document written anew loses', async () => {
    const knight = `name: Knight\n# chosen later\ngame: ${HK}\n${HK}: {}\n`
    const { id, fileId } = await sessionWithFile(`${CLAIRE}---\n${knight}`)

    const [proposal] = await balancer.suggest(
      { sessionId: id, fileId, docIndex: 1, target: { kind: 'count', value: 140 } },
      task().handle,
    )

    expect(proposal?.diff).toBe(
      [
        '-# chosen later',
        `-${HK}: {}`,
        `+${HK}:`,
        '+  RandomizeSkills: false',
        '+  RandomizeKeys: false',
      ].join('\n'),
    )
    await balancer.apply({ sessionId: id, fileId, proposalId: proposal?.id ?? '' })
    const { text } = await store.readFile(id, fileId)
    expect(text).toBe(
      `${CLAIRE}---\nname: Knight\ngame: ${HK}\n${HK}:\n  RandomizeSkills: false\n  RandomizeKeys: false\n`,
    )
  })

  it('an unknown or expired proposal id is NOT_FOUND', async () => {
    const { id, fileId } = await sessionWithFile()
    const suggest = () =>
      balancer.suggest({ sessionId: id, fileId, docIndex: 1, target: { kind: 'median' } }, task().handle)

    await expect(balancer.apply({ sessionId: id, fileId, proposalId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    // Kept one hour.
    const [kept] = await suggest()
    if (!kept) throw new Error('no proposal')
    clock += 60 * 60 * 1000 + 1
    await expect(balancer.apply({ sessionId: id, fileId, proposalId: kept.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    // Only for the file it was made for.
    const [other] = await suggest()
    if (!other) throw new Error('no proposal')
    await expect(
      balancer.apply({ sessionId: id, fileId: 'f_0', proposalId: other.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Not once the file has changed: its documents may have moved.
    await store.replaceFile(id, fileId, FILE.replace('goal: nap', 'goal: photo'))
    await expect(balancer.apply({ sessionId: id, fileId, proposalId: other.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    // Applied once: the file changed, every proposal made for it is gone.
    const [first, second] = await suggest()
    if (!first || !second) throw new Error('two proposals expected')
    await balancer.apply({ sessionId: id, fileId, proposalId: first.id })
    await expect(balancer.apply({ sessionId: id, fileId, proposalId: second.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('takes the median of the measured counts as the target', async () => {
    const { id, fileId } = await sessionWithFile()
    // Median of 100, 200 and 180: 180, which the knight at 200 reaches with RandomizeKeys off
    // (RandomizeSkills off, at 160, is no closer than now).
    last = { measuredAt: '', players: [...(last?.players ?? []), row({ checks: 180 })] }
    const proposals = await balancer.suggest(
      { sessionId: id, fileId, docIndex: 1, target: { kind: 'median' } },
      task().handle,
    )
    expect(proposals.map((p) => p.checks)).toEqual([180])
  })

  it('refuses what it cannot balance: no measure yet, a rolled game, a player it cannot measure', async () => {
    const { id, fileId } = await sessionWithFile()
    const median = { kind: 'median' } as const

    last = null
    await expect(
      balancer.suggest({ sessionId: id, fileId, docIndex: 1, target: median }, task().handle),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    last = { measuredAt: '', players: [row({ checks: 150 })] }

    await expect(
      balancer.suggest({ sessionId: id, fileId, docIndex: 2, target: median }, task().handle),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const rolled = await sessionWithFile(
      `name: Lucky\ngame:\n  ${ASH}: 1\n  ${HK}: 1\n${ASH}: {}\n${HK}: {}\n`,
    )
    await expect(
      balancer.suggest(
        { sessionId: rolled.id, fileId: rolled.fileId, docIndex: 0, target: median },
        task().handle,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    measureFails = true
    await expect(
      balancer.suggest({ sessionId: id, fileId, docIndex: 1, target: median }, task().handle),
    ).rejects.toMatchObject({ code: 'AP_ROM_MISSING' })
  })
})

describe('rewriteOptions', () => {
  const hk = schemaOf(HK)
  const off = (key: string) => ({ key, from: true, to: false })

  it('rewrites a document whose section cannot be edited in place with the writer, the others untouched', () => {
    const text = `${CLAIRE}---\nname: Knight\ngame: ${HK}\n${HK}: {} # nothing yet\n`
    const out = rewriteOptions(text, 1, [off('RandomizeSkills')], hk)
    expect(out.startsWith(`${CLAIRE}---\n`)).toBe(true)
    expect(parsePlayerYaml(out).docs[1]?.options).toEqual({
      RandomizeSkills: { mode: 'value', value: false },
    })

    // An anchor would carry the new value to its aliases: the document is written anew instead.
    const anchored = `${CLAIRE}---
name: Knight
game: ${HK}
${HK}:
  RandomizeSkills: &on true
  RandomizeCharms: *on
`
    const rewritten = rewriteOptions(anchored, 1, [off('RandomizeSkills')], hk)
    expect(
      rewritten.startsWith(`${CLAIRE}---
`),
    ).toBe(true)
    expect(parsePlayerYaml(rewritten).docs[1]?.options).toEqual({
      RandomizeSkills: { mode: 'value', value: false },
      RandomizeCharms: { mode: 'value', value: true },
    })
  })

  it('adds a missing option after the last one, whatever ends the section', () => {
    const head = `name: Knight
game: ${HK}
${HK}:
`
    // A block value (weights) ends with its own line break.
    const weighted = `${head}  StartLocation:
    kings_pass: 1
    ancestral_mound: 1
# the end
`
    expect(rewriteOptions(weighted, 0, [off('RandomizeKeys')], hk)).toBe(
      `${head}  StartLocation:
    kings_pass: 1
    ancestral_mound: 1
  RandomizeKeys: false
# the end
`,
    )
    // A file without a final line break.
    expect(rewriteOptions(`${head}  RandomizeSkills: true # on`, 0, [off('RandomizeKeys')], hk)).toBe(
      `${head}  RandomizeSkills: true # on
  RandomizeKeys: false
`,
    )
  })

  it('fills an empty value, quotes what PyYAML would misread and keeps Windows line ends', () => {
    const text = `name: Knight\r\ngame: ${HK}\r\n${HK}:\r\n  RandomizeSkills:\r\n  CostSanity: on\r\n`
    const out = rewriteOptions(
      text,
      0,
      [off('RandomizeSkills'), { key: 'CostSanity', from: true, to: 'off' }],
      hk,
    )
    expect(out).toBe(
      `name: Knight\r\ngame: ${HK}\r\n${HK}:\r\n  RandomizeSkills: false\r\n  CostSanity: "off"\r\n`,
    )
  })

  it('NOT_FOUND for a document the file does not have', () => {
    expect(() => rewriteOptions(CLAIRE, 1, [off('RandomizeSkills')], hk)).toThrow(AppError)
  })
})

describe('checks:suggest and checks:apply handlers', () => {
  let root: string
  let call: (name: string, input?: unknown) => Promise<unknown>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat balance handler é-'))
    const core = createTestContext(root)
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    call = (name, input) => ipc.dispatch(name, input, { senderId: 1 })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('checks the target and answers NOT_FOUND for an unknown proposal', async () => {
    const base = { sessionId: 's_1', fileId: 'f_1', docIndex: 0 }
    expect(await call('checks:suggest', { ...base, target: { kind: 'huge' } })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(await call('checks:suggest', { ...base, target: { kind: 'count', value: 0 } })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(await call('checks:suggest', { ...base, docIndex: -1, target: { kind: 'median' } })).toMatchObject(
      {
        error: { code: 'INVALID_INPUT' },
      },
    )
    expect(await call('checks:suggest', { ...base, target: { kind: 'long' } })).toMatchObject({
      ok: true,
      value: { taskId: expect.any(String) as string },
    })
    expect(await call('checks:apply', { sessionId: 's_1', fileId: 'f_1', proposalId: 'nope' })).toMatchObject(
      {
        error: { code: 'NOT_FOUND' },
      },
    )
  })
})

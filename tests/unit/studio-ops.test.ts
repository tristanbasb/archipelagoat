import {
  editorMode,
  humanize,
  isModified,
  isRandom,
  issueTarget,
  randomize,
  removeOption,
  resetOption,
  setWeights,
  simpleValue,
  suggestedFileName,
  toggleState,
  toSimple,
  toWeighted,
  withPreset,
} from '@renderer/features/studio/editor-ops'
import { highlightYaml } from '@renderer/features/studio/yaml-highlight'
import type { EditorDoc, GameSchema, OptionSchema } from '@shared/types'

const option = (key: string, kind: OptionSchema['kind'], value: unknown, extra: Partial<OptionSchema> = {}) =>
  ({
    key,
    group: 'Game Options',
    doc: '',
    kind,
    default: value,
    choices: [],
    range: null,
    specialNames: {},
    confidence: 'inferred',
    ...extra,
  }) satisfies OptionSchema

const GOAL = option('goal', 'choice', 'ganon', { choices: ['ganon', 'crystals', 'bosses'] })
const DEATH_LINK = option('death_link', 'toggle', false, { choices: ['false', 'true'] })
const BALANCING = option('progression_balancing', 'named-range', 50, {
  range: { min: 0, max: 99 },
  specialNames: { disabled: 0, normal: 50, extreme: 99 },
})
const INVENTORY = option('start_inventory', 'dict', {})
const MYSTERY = option('mystery', 'free', null)

const doc = (options: EditorDoc['options'] = {}): EditorDoc => ({
  name: 'Goat',
  description: '',
  game: 'Test Game',
  requiresVersion: '0.6.8',
  options,
  extraRoot: { triggers: { mode: 'raw', yaml: '- option_name: goal' } },
})

describe('studio editor ops', () => {
  it('toWeighted turns a single value into weights {value: 50}', () => {
    const before = doc({ goal: { mode: 'value', value: 'crystals' } })
    const after = toWeighted(GOAL, before)
    expect(after.options.goal).toEqual({ mode: 'weighted', weights: { crystals: 50 } })
    // The input is left alone, and nothing else changes.
    expect(before.options.goal).toEqual({ mode: 'value', value: 'crystals' })
    expect(after.extraRoot).toEqual(before.extraRoot)
    // Booleans and numbers become the keys Archipelago reads back as such.
    expect(
      toWeighted(DEATH_LINK, doc({ death_link: { mode: 'value', value: true } })).options.death_link,
    ).toEqual({ mode: 'weighted', weights: { true: 50 } })
    expect(
      toWeighted(BALANCING, doc({ progression_balancing: { mode: 'value', value: 25 } })).options
        .progression_balancing,
    ).toEqual({ mode: 'weighted', weights: { '25': 50 } })
    // An option the doc leaves out starts from its default.
    expect(toWeighted(GOAL, doc()).options.goal).toEqual({ mode: 'weighted', weights: { ganon: 50 } })
    // Nothing to start from: Archipelago's own `random`.
    expect(toWeighted(option('x', 'choice', null), doc()).options.x).toEqual({
      mode: 'weighted',
      weights: { random: 50 },
    })
    // Already weighted: unchanged.
    const weighted = doc({ goal: { mode: 'weighted', weights: { ganon: 10, bosses: 30 } } })
    expect(toWeighted(GOAL, weighted)).toBe(weighted)
  })

  it('randomize sets the option to "random"', () => {
    const before = doc({ goal: { mode: 'weighted', weights: { ganon: 50 } } })
    const after = randomize(before, 'goal')
    expect(after.options.goal).toEqual({ mode: 'value', value: 'random' })
    expect(before.options.goal).toEqual({ mode: 'weighted', weights: { ganon: 50 } })
    expect(randomize(doc(), 'death_link').options.death_link).toEqual({ mode: 'value', value: 'random' })
  })

  it('toSimple keeps the heaviest value, typed for its option', () => {
    expect(
      toSimple(GOAL, doc({ goal: { mode: 'weighted', weights: { ganon: 10, bosses: 30, crystals: 30 } } }))
        .options.goal,
    ).toEqual({ mode: 'value', value: 'bosses' })
    expect(
      toSimple(DEATH_LINK, doc({ death_link: { mode: 'weighted', weights: { false: 0, true: 50 } } })).options
        .death_link,
    ).toEqual({ mode: 'value', value: true })
    // A toggle key that is not Archipelago's random stays as written, for the validator to flag.
    expect(
      toSimple(DEATH_LINK, doc({ death_link: { mode: 'weighted', weights: { 'random-low': 50 } } })).options
        .death_link,
    ).toEqual({ mode: 'value', value: 'random-low' })
    expect(
      toSimple(
        BALANCING,
        doc({ progression_balancing: { mode: 'weighted', weights: { '30': 5, normal: 1 } } }),
      ).options.progression_balancing,
    ).toEqual({ mode: 'value', value: 30 })
    // Every weight at 0: back to the default.
    expect(
      toSimple(GOAL, doc({ goal: { mode: 'weighted', weights: { ganon: 0, bosses: 0 } } })).options.goal,
    ).toEqual({ mode: 'value', value: 'ganon' })
    const simple = doc({ goal: { mode: 'value', value: 'bosses' } })
    expect(toSimple(GOAL, simple)).toBe(simple)
  })

  it('setWeights drops the option once every weight is removed, never writing {}', () => {
    const before = doc({
      goal: { mode: 'weighted', weights: { ganon: 50 } },
      death_link: { mode: 'value', value: true },
    })
    expect(setWeights(before, 'goal', { ganon: 20, bosses: 30 }).options.goal).toEqual({
      mode: 'weighted',
      weights: { ganon: 20, bosses: 30 },
    })
    const emptied = setWeights(before, 'goal', {})
    expect(Object.keys(emptied.options)).toEqual(['death_link'])
    expect(before.options.goal).toBeDefined()
    expect(removeOption(before, 'missing')).toBe(before)
  })

  it('resetOption goes back to the default, or leaves the option out when there is none', () => {
    const changed = doc({ goal: { mode: 'value', value: 'bosses' }, mystery: { mode: 'raw', yaml: 'a: 1' } })
    expect(resetOption(GOAL, changed).options.goal).toEqual({ mode: 'value', value: 'ganon' })
    expect(resetOption(MYSTERY, changed).options).not.toHaveProperty('mystery')
  })

  it('isModified compares with the default', () => {
    expect(isModified(GOAL, undefined)).toBe(false)
    expect(isModified(GOAL, { mode: 'value', value: 'ganon' })).toBe(false)
    expect(isModified(GOAL, { mode: 'value', value: 'bosses' })).toBe(true)
    expect(isModified(GOAL, { mode: 'weighted', weights: { ganon: 50 } })).toBe(true)
    expect(isModified(INVENTORY, { mode: 'value', value: {} })).toBe(false)
    expect(isModified(MYSTERY, { mode: 'raw', yaml: '' })).toBe(true)
  })

  it('editorMode and simpleValue pick the control an option value needs', () => {
    expect(editorMode(GOAL, undefined)).toBe('simple')
    expect(editorMode(GOAL, { mode: 'weighted', weights: { ganon: 1 } })).toBe('weighted')
    expect(editorMode(GOAL, { mode: 'raw', yaml: '!!float 5' })).toBe('raw')
    expect(editorMode(GOAL, { mode: 'value', value: ['ganon', 'bosses'] })).toBe('raw')
    // Complex options are always edited as YAML, even when they read like weights.
    expect(editorMode(INVENTORY, { mode: 'weighted', weights: { Bomb: 10 } })).toBe('raw')
    expect(editorMode(MYSTERY, undefined)).toBe('raw')
    expect(simpleValue(GOAL, undefined)).toBe('ganon')
    expect(simpleValue(GOAL, { mode: 'value', value: 'bosses' })).toBe('bosses')
  })

  it('toggleState reads every spelling Archipelago accepts', () => {
    for (const on of [true, 1, 'true', 'On', 'yes', 'enabled', '1']) expect(toggleState(on)).toBe(true)
    for (const off of [false, 0, 'false', 'off', 'no', 'disabled', 'none'])
      expect(toggleState(off)).toBe(false)
    expect(toggleState('random')).toBe('random')
    // Toggle.from_text takes `random` alone, as it is: the validator refuses the rest.
    for (const other of ['random-low', 'Random', 'randomize']) expect(toggleState(other)).toBeNull()
    expect(toggleState('maybe')).toBeNull()
  })

  it('isRandom reads a random pick as each kind does, and never a choice', () => {
    const SILO = option('silo', 'choice', 'vanilla', { choices: ['vanilla', 'spawn', 'randomize_recipe'] })
    const SCRUBS = option('shuffle_scrubs', 'choice', 'off', {
      choices: ['off', 'low', 'regular', 'random_prices'],
    })
    const SHOP = option('randomize_shop_inventories', 'text-choice', 'default', {
      choices: ['default', 'randomize_by_shop_type'],
    })
    const AMOUNT = option('amount', 'range', 5, { range: { min: 1, max: 10 } })
    const COUNT = option('count', 'named-range', 0, {
      range: { min: 0, max: 9 },
      specialNames: { random_start: 3 },
    })
    // Real choices that start like a random pick are choices.
    expect(isRandom(SILO, 'randomize_recipe')).toBe(false)
    expect(isRandom(SILO, 'Randomize_Recipe')).toBe(false)
    expect(isRandom(SCRUBS, 'random_prices')).toBe(false)
    expect(isRandom(SHOP, 'randomize_by_shop_type')).toBe(false)
    // Choice and TextChoice take `random` alone, in any case.
    expect(isRandom(SILO, 'random')).toBe(true)
    expect(isRandom(SHOP, 'Random')).toBe(true)
    expect(isRandom(SILO, 'random-low')).toBe(false)
    expect(isRandom(SHOP, 'random_text')).toBe(false)
    // Toggle takes `random` as it is.
    expect(isRandom(DEATH_LINK, 'random')).toBe(true)
    expect(isRandom(DEATH_LINK, 'Random')).toBe(false)
    expect(isRandom(DEATH_LINK, 'random-low')).toBe(false)
    // A Range takes every random… text, but a special name stays a special name.
    for (const text of ['random', 'random-low', 'Random-High', 'random-range-2-8']) {
      expect(isRandom(AMOUNT, text)).toBe(true)
    }
    expect(isRandom(BALANCING, 'random-middle')).toBe(true)
    expect(isRandom(COUNT, 'random_start')).toBe(false)
    // Not text, or a kind edited as YAML: never.
    expect(isRandom(AMOUNT, 5)).toBe(false)
    expect(isRandom(SILO, null)).toBe(false)
    expect(isRandom(MYSTERY, 'random')).toBe(false)
  })

  it('withPreset starts from the defaults, keeps the player, then sets the preset', () => {
    const schema: GameSchema = {
      game: 'Test Game',
      source: 'local',
      apVersion: '0.6.8',
      groups: [{ name: 'Game Options', options: [GOAL, DEATH_LINK] }],
      presets: { Hard: { death_link: true } },
    }
    const mine = {
      ...doc({ goal: { mode: 'value', value: 'bosses' }, extra: { mode: 'value', value: 1 } }),
      description: 'Mine',
    }
    const hard = withPreset(schema, mine, 'Hard')
    expect(hard.options).toEqual({
      goal: { mode: 'value', value: 'ganon' },
      death_link: { mode: 'value', value: true },
    })
    expect(hard.name).toBe('Goat')
    expect(hard.description).toBe('Mine')
    expect(hard.extraRoot).toEqual(mine.extraRoot)
    expect(withPreset(schema, mine, null).options).toEqual({
      goal: { mode: 'value', value: 'ganon' },
      death_link: { mode: 'value', value: false },
    })
  })

  it('issueTarget links an issue to the option, the name or the game it is about', () => {
    expect(
      issueTarget({ severity: 'error', code: 'option-float', path: 'Test Game.goal' }, 'Test Game'),
    ).toEqual({
      kind: 'option',
      key: 'goal',
    })
    expect(issueTarget({ severity: 'error', code: 'name-too-long', path: 'name' }, 'Test Game')).toEqual({
      kind: 'name',
    })
    expect(issueTarget({ severity: 'error', code: 'no-game', path: 'game' }, 'Test Game')).toEqual({
      kind: 'game',
    })
    // The game section itself (missing, null): the game is what to look at.
    expect(
      issueTarget({ severity: 'error', code: 'game-section-null', path: 'Test Game' }, 'Test Game'),
    ).toEqual({
      kind: 'game',
    })
    expect(
      issueTarget(
        { severity: 'error', code: 'requires-version-format', path: 'requires.version' },
        'Test Game',
      ),
    ).toBeNull()
    expect(issueTarget({ severity: 'error', code: 'yaml-syntax' }, 'Test Game')).toBeNull()
  })

  it('humanize and suggestedFileName make names people can read', () => {
    expect(humanize('progression_balancing')).toBe('Progression balancing')
    expect(humanize('6_coins')).toBe('6 coins')
    expect(suggestedFileName(doc())).toBe('Goat.yaml')
    expect(suggestedFileName({ ...doc(), name: 'Player{number}' })).toBe('Player.yaml')
    expect(suggestedFileName({ ...doc(), name: ' a/b:c? ' })).toBe('abc.yaml')
    expect(suggestedFileName({ ...doc(), name: '' })).toBe('Test Game.yaml')
    expect(suggestedFileName({ ...doc(), name: '', game: '' })).toBe('Player.yaml')
  })
})

describe('yaml highlighter', () => {
  it('splits each line into neon tokens', () => {
    const lines = highlightYaml(
      [
        'name: Goat # me',
        'requires:',
        '  version: "0.6.8"',
        'Test Game:',
        "  death_link: 'true'",
        '  amount: 42',
        '  on_off: yes',
        '  items:',
        '  - Bomb',
        '---',
      ].join('\n'),
    )
    expect(lines).toHaveLength(10)
    const kinds = (index: number) => lines[index]?.map((token) => [token.kind, token.text])
    expect(kinds(0)).toEqual([
      ['key', 'name'],
      ['punct', ':'],
      ['plain', ' '],
      ['string', 'Goat'],
      ['comment', ' # me'],
    ])
    expect(kinds(2)).toEqual([
      ['plain', '  '],
      ['key', 'version'],
      ['punct', ':'],
      ['plain', ' '],
      ['quoted', '"0.6.8"'],
    ])
    expect(kinds(4)?.at(-1)).toEqual(['quoted', "'true'"])
    expect(kinds(5)?.at(-1)).toEqual(['number', '42'])
    expect(kinds(6)?.at(-1)).toEqual(['bool', 'yes'])
    expect(kinds(8)).toEqual([
      ['plain', '  '],
      ['punct', '-'],
      ['plain', ' '],
      ['string', 'Bomb'],
    ])
    expect(kinds(9)).toEqual([['punct', '---']])
    // The text is kept exactly.
    expect(lines.map((line) => line.map((token) => token.text).join(''))[3]).toBe('Test Game:')
  })
})

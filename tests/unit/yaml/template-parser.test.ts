import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSafeName, parseTemplate, readTemplateHeader } from '@main/core/yaml/template-parser'
import type { GameSchema, OptionKind, OptionSchema } from '@shared/types'

const AP_SRC = process.env.AP_SRC
const DIR = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const FIXTURES = readdirSync(DIR)
  .filter((name) => name.endsWith('.yaml'))
  .sort()
const KINDS: readonly OptionKind[] = [
  'toggle',
  'choice',
  'text-choice',
  'range',
  'named-range',
  'list',
  'set',
  'dict',
  'free',
]

const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const schemaOf = (name: string): GameSchema => parseTemplate(fixture(name))
const allOptions = (schema: GameSchema): OptionSchema[] => schema.groups.flatMap((group) => group.options)

function option(schema: GameSchema, key: string): OptionSchema {
  const found = allOptions(schema).find((o) => o.key === key)
  if (!found) throw new Error(`no option ${key} in ${schema.game}`)
  return found
}

/** The `# Group #` banners of a template that an option follows, in file order. */
const banners = (text: string): string[] =>
  [...text.matchAll(/^ {2}#{3,}\n {2}# (.*) #\n {2}#{3,}\n(?= {2}\w+:\n)/gm)].map((m) => m[1] ?? '')

/** A minimal template around a game section body (each line already indented). */
function template(body: string[], game = 'Test Game'): string {
  return [
    'name: Player{number}',
    `description: Default ${game} Template`,
    `game: ${game}`,
    'requires:',
    '  version: 0.6.8 # Version of Archipelago required for this yaml to work as expected.',
    '',
    `${game}:`,
    ...body,
    '',
  ].join('\n')
}

describe('parseTemplate on real templates', () => {
  it('has at least 10 real templates to read', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(FIXTURES)('parses %s: game name, ≥1 group, every option has key/kind/default', (name) => {
    const text = fixture(name)
    const schema = parseTemplate(text)
    expect(`${fileSafeName(schema.game)}.yaml`).toBe(name)
    expect(schema.source).toBe('local')
    expect(schema.apVersion).toBe('0.6.8')
    expect(schema.presets).toEqual({})
    expect(schema.groups.length).toBeGreaterThanOrEqual(1)
    // Every option of the file, and nothing else: the 2-space keys of the game section (the last
    // top-level key).
    const lines = text.split('\n')
    const section = lines.findLastIndex((line) => /^[^\s#].*:$/.test(line))
    const keys = lines
      .slice(section + 1)
      .map((line) => /^ {2}(\w+):$/.exec(line)?.[1])
      .filter((key) => key !== undefined)
    expect(keys.length).toBeGreaterThan(10)
    expect(allOptions(schema).map((o) => o.key)).toEqual(keys)
    for (const group of schema.groups) {
      expect(group.options.length).toBeGreaterThan(0)
      for (const o of group.options) {
        expect(o.key).not.toBe('')
        expect(o.group).toBe(group.name)
        expect(KINDS).toContain(o.kind)
        expect(o).toHaveProperty('default')
        expect(o.default).not.toBeUndefined()
        expect(o.confidence).toBe(['range', 'named-range', 'toggle'].includes(o.kind) ? 'exact' : 'inferred')
        if (o.kind === 'range' || o.kind === 'named-range') {
          expect(o.range).not.toBeNull()
          expect(o.range!.min).toBeLessThanOrEqual(o.range!.max)
        } else {
          expect(o.range).toBeNull()
        }
        expect(Object.keys(o.specialNames).length > 0).toBe(o.kind === 'named-range')
        if (o.kind === 'toggle') expect(typeof o.default).toBe('boolean')
        if (o.kind === 'choice') expect(o.choices).toContain(o.default)
      }
    }
  })

  it('ALttP progression_balancing is named-range 0..99 default 50 with special names', () => {
    expect(option(schemaOf('A Link to the Past.yaml'), 'progression_balancing')).toEqual({
      key: 'progression_balancing',
      group: 'Game Options',
      doc:
        'A system that can move progression earlier, to try and prevent the player from getting stuck and bored early.\n' +
        '\n' +
        'A lower setting means more getting stuck. A higher setting means less getting stuck.',
      kind: 'named-range',
      default: 50,
      choices: [],
      range: { min: 0, max: 99 },
      specialNames: { disabled: 0, normal: 50, extreme: 99 },
      confidence: 'exact',
    })
  })

  it('a range without special names is a range whose default is the number weighted 50', () => {
    expect(option(schemaOf('A Link to the Past.yaml'), 'crystals_needed_for_gt')).toMatchObject({
      kind: 'range',
      default: 7,
      range: { min: 0, max: 7 },
      specialNames: {},
      confidence: 'exact',
    })
    expect(option(schemaOf('A Link to the Past.yaml'), 'triforce_pieces_percentage')).toMatchObject({
      kind: 'range',
      default: 150,
      range: { min: 100, max: 1000 },
    })
  })

  it('a named range whose default is a special name outside the range takes its value', () => {
    // `vanilla: 50 # equivalent to -1` on a 50..100 range.
    expect(option(schemaOf('Pokemon Emerald.yaml'), 'hm_compatibility')).toMatchObject({
      kind: 'named-range',
      default: -1,
      range: { min: 50, max: 100 },
      specialNames: { vanilla: -1, full: 100 },
    })
    // Option keys keep their case.
    expect(option(schemaOf('Hollow Knight.yaml'), 'GrubHuntGoal')).toMatchObject({
      kind: 'named-range',
      default: 46,
      range: { min: 1, max: 46 },
      specialNames: { all: -1, forty_six: 46 },
      doc: "The amount of grubs required to finish Grub Hunt.\nOn 'All' any grubs from item links replacements etc. will be counted",
    })
  })

  it('a toggle option parses as toggle with boolean default', () => {
    const alttp = schemaOf('A Link to the Past.yaml')
    expect(option(alttp, 'key_drop_shuffle')).toEqual({
      key: 'key_drop_shuffle',
      group: 'Game Options',
      doc: 'Shuffle keys found in pots and dropped from killed enemies,\nrespects the small key and big key shuffle options.',
      kind: 'toggle',
      default: true,
      choices: ['false', 'true'],
      range: null,
      specialNames: {},
      confidence: 'exact',
    })
    expect(option(alttp, 'restrict_dungeon_item_on_boss')).toMatchObject({ kind: 'toggle', default: false })
  })

  it('a choice option lists all choices and default has weight 50', () => {
    const alttp = schemaOf('A Link to the Past.yaml')
    expect(option(alttp, 'goal')).toMatchObject({
      kind: 'choice',
      default: 'ganon',
      choices: [
        'ganon',
        'crystals',
        'bosses',
        'pedestal',
        'ganon_pedestal',
        'triforce_hunt',
        'local_triforce_hunt',
        'ganon_triforce_hunt',
        'local_ganon_triforce_hunt',
      ],
      range: null,
      specialNames: {},
      confidence: 'inferred',
    })
    expect(option(alttp, 'mode')).toMatchObject({
      default: 'open',
      choices: ['standard', 'open', 'inverted'],
    })
    // Quoted YAML 1.1 keywords stay the names they are.
    expect(option(alttp, 'progressive')).toMatchObject({
      kind: 'choice',
      default: 'on',
      choices: ['off', 'grouped_random', 'on'],
    })
    expect(option(schemaOf('TUNIC.yaml'), 'entrance_rando')).toMatchObject({
      kind: 'choice',
      default: 'no',
      choices: ['no', 'yes'],
    })
  })

  it('reads the other kinds: weighted free text, lists, sets and dicts', () => {
    const alttp = schemaOf('A Link to the Past.yaml')
    expect(option(alttp, 'entrance_shuffle_seed')).toMatchObject({
      kind: 'text-choice',
      default: 'random',
      choices: [],
      confidence: 'inferred',
    })
    expect(option(alttp, 'plando_connections')).toMatchObject({ kind: 'list', default: [] })
    expect(option(alttp, 'local_items')).toMatchObject({ kind: 'set', default: [] })
    expect(option(alttp, 'exclude_locations')).toMatchObject({ kind: 'set', default: [] })
    expect(option(alttp, 'start_inventory')).toMatchObject({ kind: 'dict', default: {} })

    expect(option(schemaOf('Pokemon Emerald.yaml'), 'free_fly_blacklist')).toMatchObject({
      kind: 'list',
      default: ['Littleroot Town', 'Oldale Town', 'Petalburg City', 'Rustboro City', 'Dewford Town'],
    })

    const worldGen = option(schemaOf('Factorio.yaml'), 'world_gen')
    expect(worldGen.kind).toBe('dict')
    expect(worldGen.doc).toBe(
      'World Generation settings. Overview of options at https://wiki.factorio.com/Map_generator,\n' +
        'with in-depth documentation at https://lua-api.factorio.com/latest/concepts/MapGenSettings.html',
    )
    expect(worldGen.default).toMatchObject({
      autoplace_controls: { coal: { frequency: 1, richness: 6, size: 3 } },
      enemy_evolution: { enabled: true, pollution_factor: 9.0e-7 },
      seed: null,
      starting_area: 1,
    })

    const dicts = allOptions(schemaOf('Timespinner.yaml')).filter((o) => o.kind === 'dict')
    expect(dicts.map((o) => o.default)).toContainEqual(expect.objectContaining({ Xarion: 'Xarion' }))
  })

  it('groups keep template order with "Game Options" first when present', () => {
    for (const name of FIXTURES) {
      const text = fixture(name)
      const names = parseTemplate(text).groups.map((group) => group.name)
      expect(names).toEqual(banners(text))
      if (names.includes('Game Options')) expect(names[0]).toBe('Game Options')
    }
    expect(schemaOf('Ocarina of Time.yaml').groups.map((group) => group.name)).toEqual([
      'Game Options',
      'Open',
      'World',
      'Shuffle',
      'Dungeon Items',
      'Timesavers',
      'Misc',
      'Item Pool',
      'Cosmetics',
      'SFX',
      'Item & Location Options',
    ])
    // Stardew Valley hides every option of its "Game Options" banner: the empty group is left out.
    const stardew = fixture('Stardew Valley.yaml')
    expect(stardew).toContain('  # Game Options #\n')
    expect(parseTemplate(stardew).groups.map((group) => group.name)).not.toContain('Game Options')
  })

  it('docs are joined without leading "# "', () => {
    const alttp = schemaOf('A Link to the Past.yaml')
    expect(option(alttp, 'crystals_needed_for_gt').doc).toBe(
      "Number of crystals needed to open Ganon's Tower",
    )
    // Indentation inside a doc line is kept: only the `#` and one space go.
    expect(option(alttp, 'plando_connections').doc).toBe(
      [
        'Generic connections plando. Format is:',
        '- entrance: "Entrance Name"',
        '  exit: "Exit Name"',
        '  direction: "Direction"',
        '  percentage: 100',
        "Direction must be one of 'entrance', 'exit', or 'both', and defaults to 'both' if omitted.",
        'Percentage is an integer from 1 to 100, and defaults to 100 when omitted.',
      ].join('\n'),
    )
    for (const name of FIXTURES) {
      for (const o of allOptions(schemaOf(name))) {
        expect(o.doc).not.toMatch(/^#/m)
        expect(o.doc).not.toMatch(/^\s|\s$/)
        expect(o.doc).not.toContain(
          'You can define additional values between the minimum and maximum values.',
        )
        expect(o.doc).not.toMatch(/^(?:Minimum|Maximum) value is -?\d+$/m)
      }
    }
  })
})

describe('parseTemplate on edge cases', () => {
  it('reads CRLF line ends and a BOM like the plain file', () => {
    const text = fixture('Stardew Valley.yaml')
    const crlf = `\uFEFF${text.replace(/^\uFEFF/, '').replace(/\n/g, '\r\n')}`
    expect(parseTemplate(crlf)).toEqual(parseTemplate(text))
  })

  it('takes the game from the header, quoted names included', () => {
    const schema = schemaOf('Jak and Daxter The Precursor Legacy.yaml')
    expect(schema.game).toBe('Jak and Daxter: The Precursor Legacy')
  })

  it('puts options before any banner in "Game Options" and reads a bare value as free', () => {
    const schema = parseTemplate(
      template([
        '  seed_count:',
        '    # A plain number.',
        '    5',
        '',
        '  ########',
        '  # Misc #',
        '  ########',
        '  nothing:',
        '',
        '  custom_text:',
        '    # A text choice set to a custom text.',
        '    first: 0',
        '    second: 0',
        "    'my own text': 50",
      ]),
    )
    expect(schema.groups.map((group) => [group.name, group.options.map((o) => o.key)])).toEqual([
      ['Game Options', ['seed_count']],
      ['Misc', ['nothing', 'custom_text']],
    ])
    expect(option(schema, 'seed_count')).toMatchObject({ kind: 'free', default: 5, doc: 'A plain number.' })
    expect(option(schema, 'nothing')).toMatchObject({ kind: 'free', default: null, doc: '' })
    expect(option(schema, 'custom_text')).toMatchObject({
      kind: 'choice',
      default: 'my own text',
      choices: ['first', 'second', 'my own text'],
    })
  })

  it('reads a mapping that is not one weight of 50 as a dict, and drops empty groups', () => {
    const schema = parseTemplate(
      template([
        '  ##########',
        '  # Hidden #',
        '  ##########',
        '',
        '  ########',
        '  # Traps #',
        '  ########',
        '  trap_weights:',
        '    Bee Trap: 50',
        '    Ice Trap: 50',
        '',
        '  counts:',
        '    Bomb: 1',
        '    Arrow: 0',
      ]),
    )
    expect(schema.groups.map((group) => group.name)).toEqual(['Traps'])
    expect(option(schema, 'trap_weights')).toMatchObject({
      kind: 'dict',
      default: { 'Bee Trap': 50, 'Ice Trap': 50 },
    })
    expect(option(schema, 'counts')).toMatchObject({ kind: 'dict', default: { Bomb: 1, Arrow: 0 } })
  })

  it('keeps a range default that is not a number as written', () => {
    const schema = parseTemplate(
      template([
        '  level:',
        '    # You can define additional values between the minimum and maximum values.',
        '    # Minimum value is -10',
        '    # Maximum value is 10',
        '    random: 50',
        '    random-low: 0 # random value weighted towards lower values',
        '    random-high: 0 # random value weighted towards higher values',
        '    random-range--10-10: 0 # random value between -10 and 10',
      ]),
    )
    expect(option(schema, 'level')).toMatchObject({
      kind: 'range',
      default: 'random',
      range: { min: -10, max: 10 },
      doc: '',
    })
  })

  it('reads Python collections as plain data and a broken value as free', () => {
    const schema = parseTemplate(
      template([
        '  pairs:',
        '    first: !!python/tuple [1, 2]',
        '    second: !!set {a: null, b: null}',
        '    third: !!omap [{x: 1}]',
        '',
        '  broken:',
        '    [unclosed',
      ]),
    )
    expect(option(schema, 'pairs')).toMatchObject({
      kind: 'dict',
      default: { first: [1, 2], second: ['a', 'b'], third: { x: 1 } },
    })
    expect(option(schema, 'broken')).toMatchObject({ kind: 'free', default: null })
  })

  it('refuses a text that is not a template', () => {
    expect(() => parseTemplate('game: Foo\n{broken:\n')).toThrow(
      expect.objectContaining({ code: 'YAML_PARSE' }),
    )
    expect(() => parseTemplate('just: some yaml\n')).toThrow(expect.objectContaining({ code: 'YAML_PARSE' }))
    expect(() => parseTemplate('<html><body>404</body></html>')).toThrow(
      expect.objectContaining({ code: 'YAML_PARSE' }),
    )
    expect(() => parseTemplate('')).toThrow(expect.objectContaining({ code: 'YAML_PARSE' }))
  })
})

describe('readTemplateHeader', () => {
  it('reads the game, the description and the required version', () => {
    expect(readTemplateHeader(fixture('Jak and Daxter The Precursor Legacy.yaml'))).toEqual({
      game: 'Jak and Daxter: The Precursor Legacy',
      description: 'Default Jak and Daxter: The Precursor Legacy Template',
      apVersion: '0.6.8',
    })
  })

  it('answers nulls for a text without a header', () => {
    expect(readTemplateHeader('meta_description: x\n')).toEqual({
      game: null,
      description: null,
      apVersion: null,
    })
    expect(readTemplateHeader('{ broken')).toEqual({ game: null, description: null, apVersion: null })
  })
})

describe('fileSafeName', () => {
  it('fileSafeName strips <>:"/\\|?*', () => {
    expect(fileSafeName('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
    expect(fileSafeName('Jak and Daxter: The Precursor Legacy')).toBe('Jak and Daxter The Precursor Legacy')
    expect(fileSafeName("Yu-Gi-Oh! 2006 - Kirby's Dream Land 3 (é)")).toBe(
      "Yu-Gi-Oh! 2006 - Kirby's Dream Land 3 (é)",
    )
  })

  it.runIf(AP_SRC)('removes the characters of Utils.get_file_safe_name (AP_SRC)', () => {
    const utils = readFileSync(join(AP_SRC ?? '', 'Utils.py'), 'utf8')
    const literal =
      /def get_file_safe_name\(name: str\) -> str:\s+return "".join\(c for c in name if c not in '(.+)'\)/.exec(
        utils,
      )?.[1]
    expect(literal).toBeDefined()
    // The Python literal escapes its backslash.
    const chars = (literal ?? '').replace(/\\\\/g, '\\')
    expect(fileSafeName(`x${chars}y`)).toBe('xy')
    expect([...chars].sort()).toEqual([...'<>:"/\\|?*'].sort())
  })
})

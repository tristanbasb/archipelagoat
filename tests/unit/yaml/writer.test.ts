import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { loadYaml11, PYYAML_OPTIONS } from '@main/core/yaml/load'
import { parseTemplate } from '@main/core/yaml/template-parser'
import { parsePlayerYaml, quoteIfAmbiguous, renderPlayerDoc, renderPlayerYaml } from '@main/core/yaml/writer'
import { docFromSchema } from '@shared/studio-model'
import type { EditorDoc, GameSchema, OptionValue } from '@shared/types'

const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const TEMPLATE_FIXTURES = readdirSync(TEMPLATES)
  .filter((name) => name.endsWith('.yaml'))
  .sort()
const schemaOf = (name: string): GameSchema => parseTemplate(readFileSync(join(TEMPLATES, name), 'utf8'))

/** The documents as PyYAML builds them: keys keep their type (true ≠ 'true'), sets stay sets. */
const typed = (text: string): unknown[] =>
  parseAllDocuments(text, PYYAML_OPTIONS)
    .map((doc) => doc.toJS({ mapAsMap: true }) as unknown)
    .filter((doc) => doc !== null)

const editorDoc = (over: Partial<EditorDoc> = {}): EditorDoc => ({
  name: 'Goat',
  description: '',
  game: 'TUNIC',
  requiresVersion: '0.6.8',
  options: {},
  extraRoot: {},
  ...over,
})

const value = (v: unknown): OptionValue => ({ mode: 'value', value: v })

/** The one document `text` parses into. */
function parsedOne(text: string): EditorDoc {
  const { docs, issues } = parsePlayerYaml(text)
  expect(issues).toEqual([])
  expect(docs).toHaveLength(1)
  return docs[0]!
}

describe('quoteIfAmbiguous', () => {
  it('quotes yes/no/on/off/0755/1:20 and requires.version', () => {
    for (const s of [
      'yes',
      'no',
      'on',
      'off',
      'Yes',
      'NO',
      'True',
      'null',
      '~',
      '',
      '0755',
      '1:20',
      '1_000',
      '42',
      '.5',
      '1.5',
      '-.inf',
      '2020-01-02',
      '=',
      '<<',
    ]) {
      expect(quoteIfAmbiguous(s)).toBe(JSON.stringify(s))
    }
    const text = renderPlayerYaml(
      editorDoc({ options: { fool_traps: value('off'), entrance_rando: value('yes') } }),
    )
    expect(text).toContain('version: "0.6.8"\n')
    expect(text).toContain('  fool_traps: "off"\n')
    expect(text).toContain('  entrance_rando: "yes"\n')
  })

  it('leaves alone what PyYAML reads as a string, plain YAML 1.2 lookalikes included', () => {
    for (const s of [
      'Goat',
      'Player{number}',
      'café',
      'y',
      'n',
      '1e5',
      '08',
      '0:20',
      '2020-1-2',
      'a:b',
      'random-range-1-5',
    ]) {
      expect(quoteIfAmbiguous(s)).toBe(s)
    }
  })

  it('quotes what cannot be plain and escapes what PyYAML would fold or refuse', () => {
    expect(quoteIfAmbiguous('a: b')).toBe('"a: b"')
    expect(quoteIfAmbiguous('#tag')).toBe('"#tag"')
    expect(quoteIfAmbiguous('- item')).toBe('"- item"')
    expect(quoteIfAmbiguous(' padded')).toBe('" padded"')
    expect(quoteIfAmbiguous('--- x')).toBe('"--- x"')
    expect(quoteIfAmbiguous('"hi" she said')).toBe('"\\"hi\\" she said"')
    expect(quoteIfAmbiguous('say "hi"')).toBe('say "hi"')
    expect(quoteIfAmbiguous('two\nlines')).toBe('"two\\nlines"')
    expect(quoteIfAmbiguous('a\u2028b\u0085c\u0007')).toBe('"a\\u2028b\\x85c\\x07"')
  })
})

describe('renderPlayerYaml', () => {
  it('writes {} for empty game section', () => {
    expect(renderPlayerYaml(editorDoc())).toBe(
      'name: Goat\ngame: TUNIC\nrequires:\n  version: "0.6.8"\nTUNIC: {}\n',
    )
    const jak = renderPlayerYaml(
      editorDoc({ game: 'Jak and Daxter: The Precursor Legacy', requiresVersion: null }),
    )
    expect(jak).toContain(
      'game: "Jak and Daxter: The Precursor Legacy"\n"Jak and Daxter: The Precursor Legacy": {}\n',
    )
    expect(loadYaml11(jak).docs).toEqual([
      {
        name: 'Goat',
        game: 'Jak and Daxter: The Precursor Legacy',
        'Jak and Daxter: The Precursor Legacy': {},
      },
    ])
  })

  it('writes UTF-8 text without BOM, LF only', () => {
    const text = renderPlayerYaml(editorDoc({ description: 'Zoé\r\nnext line' }))
    expect(text.startsWith('\uFEFF')).toBe(false)
    expect(text).not.toMatch(/\r(?!\\)/)
    expect(loadYaml11(text).docs[0]).toMatchObject({ description: 'Zoé\r\nnext line' })
  })

  it('writes every mode: values, weights (string keys) and raw YAML', () => {
    const text = renderPlayerYaml(
      editorDoc({
        options: {
          sword_progression: { mode: 'weighted', weights: { true: 50, false: 0 } },
          hexagon_goal: value(25),
          start_inventory: value({ Fairy: 2 }),
          local_items: { mode: 'raw', yaml: '- Sword  # a comment\n- Shield\n' },
          plando_items: { mode: 'raw', yaml: '   ' },
        },
      }),
    )
    expect(typed(text)).toEqual([
      new Map<unknown, unknown>([
        ['name', 'Goat'],
        ['game', 'TUNIC'],
        ['requires', new Map([['version', '0.6.8']])],
        [
          'TUNIC',
          new Map<unknown, unknown>([
            [
              'sword_progression',
              new Map([
                ['true', 50],
                ['false', 0],
              ]),
            ],
            ['hexagon_goal', 25],
            ['start_inventory', new Map([['Fairy', 2]])],
            ['local_items', ['Sword', 'Shield']],
          ]),
        ],
      ]),
    ])
  })

  it('reports invalid raw YAML and leaves that option out', () => {
    const { text, issues } = renderPlayerDoc(
      editorDoc({ options: { local_items: { mode: 'raw', yaml: '[Sword' }, hexagon_goal: value(3) } }),
    )
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'yaml-syntax', path: 'TUNIC.local_items' }),
    ])
    expect(loadYaml11(text).docs[0]).toEqual({
      name: 'Goat',
      game: 'TUNIC',
      requires: { version: '0.6.8' },
      TUNIC: { hexagon_goal: 3 },
    })
  })

  it('with the schema: integers for ranges, ints as range weight keys', () => {
    const tunic = schemaOf('TUNIC.yaml')
    const text = renderPlayerYaml(
      editorDoc({
        options: {
          hexagon_goal: value(24.6),
          extra_hexagon_percentage: { mode: 'weighted', weights: { '10': 1, '10.2': 2, random: 3 } },
          fool_traps: { mode: 'weighted', weights: { '1': 1 } },
        },
      }),
      tunic,
    )
    expect(text).toContain('  hexagon_goal: 25\n  extra_hexagon_percentage:\n    10: 3\n    random: 3\n')
    expect(text).toContain('  fool_traps:\n    "1": 1\n')
  })

  it('never writes a negative random range (Archipelago mis-reads it)', () => {
    const alttp = schemaOf('A Link to the Past.yaml')
    const render = (option: OptionValue): unknown =>
      (
        loadYaml11(
          renderPlayerYaml(editorDoc({ game: alttp.game, options: { red_clock_time: option } }), alttp),
        ).docs[0] as Record<string, Record<string, unknown>>
      )[alttp.game]?.red_clock_time
    // red_clock_time is -60..60: the whole range is plain `random`.
    expect(render(value('random-range--60-60'))).toBe('random')
    expect(render(value('random-range-high--60-60'))).toBe('random-high')
    // A part of it: the same odds, as weights on each value.
    expect(render(value('random-range--2-1'))).toEqual({ '-2': 1, '-1': 1, '0': 1, '1': 1 })
    expect(render(value('random-range-low--1-1'))).toEqual({ '-1': 3, '0': 2, '1': 1 })
    expect(render({ mode: 'weighted', weights: { 'random-range--1-0': 2, '5': 1 } })).toEqual({
      '-1': 2,
      '0': 2,
      '5': 2,
    })
    expect(render({ mode: 'weighted', weights: { 'random-range--1-0': 0, '5': 1 } })).toEqual({ '5': 1 })
    expect(render(value('random-range-5-20'))).toBe('random-range-5-20')
    // Out of range: left for the validation to report.
    expect(render(value('random-range--90-0'))).toBe('random-range--90-0')
  })

  it('the core fields win over the same keys of extraRoot', () => {
    const text = renderPlayerYaml(
      editorDoc({
        name: '',
        game: '',
        requiresVersion: '0.6.8',
        extraRoot: {
          name: value({ Alice: 1, Bob: 1 }),
          game: value({ TUNIC: 1, 'A Link to the Past': 1 }),
          requires: value({ version: 0.5, plando: 'bosses' }),
          TUNIC: value({}),
        },
      }),
    )
    expect(loadYaml11(text).docs[0]).toEqual({
      name: { Alice: 1, Bob: 1 },
      game: { TUNIC: 1, 'A Link to the Past': 1 },
      requires: { version: '0.6.8', plando: 'bosses' },
      TUNIC: {},
    })
  })

  it('roundtrip: render(defaults of each fixture schema) then load gives same values', () => {
    for (const name of TEMPLATE_FIXTURES) {
      const schema = schemaOf(name)
      const text = renderPlayerYaml(docFromSchema(schema, 'Goat'), schema)
      const { docs, issues } = loadYaml11(text)
      expect(issues).toEqual([])
      expect(docs).toHaveLength(1)
      const root = docs[0] as Record<string, unknown>
      expect(root).toMatchObject({ name: 'Goat', game: schema.game, requires: { version: '0.6.8' } })
      const section = root[schema.game] as Record<string, unknown>
      for (const option of schema.groups.flatMap((group) => group.options)) {
        expect([option.key, section[option.key]]).toEqual([option.key, option.default])
      }
    }
  })
})

describe('parsePlayerYaml', () => {
  it('reads the core fields, the options and every other root key', () => {
    const doc = parsedOne(
      [
        'name: Goat',
        'description: Testing',
        'game: TUNIC',
        'requires:',
        '  version: 0.6.8',
        '  plando: bosses',
        'quantity: 1',
        'TUNIC:',
        '  hexagon_goal: 20',
        '  fool_traps: {normal: 50, "off": 0}',
        '  start_inventory: {Fairy: "2"}',
        '  sword_progression: {true: 50, false: 0}',
        '  difficulty: 1.0',
        '',
      ].join('\n'),
    )
    expect(doc).toEqual({
      name: 'Goat',
      description: 'Testing',
      game: 'TUNIC',
      requiresVersion: '0.6.8',
      options: {
        hexagon_goal: value(20),
        fool_traps: { mode: 'weighted', weights: { normal: 50, off: 0 } },
        start_inventory: value({ Fairy: '2' }),
        // Boolean keys and a float holding an integer do not survive JS: kept as YAML.
        sword_progression: { mode: 'raw', yaml: 'true: 50\nfalse: 0' },
        difficulty: { mode: 'raw', yaml: '1.0' },
      },
      extraRoot: { requires: value({ plando: 'bosses' }), quantity: value(1) },
    })
  })

  it('a missing or odd core field stays in extraRoot', () => {
    expect(parsedOne('game:\n  TUNIC: 1\n  Factorio: 1\nTUNIC: {}\nFactorio: {}\n')).toEqual({
      name: '',
      description: '',
      game: '',
      requiresVersion: null,
      options: {},
      extraRoot: {
        game: value({ TUNIC: 1, Factorio: 1 }),
        TUNIC: value({}),
        Factorio: value({}),
      },
    })
    expect(parsedOne("name: ''\ngame: TUNIC\nrequires:\n  version: 0.7\nTUNIC:\n")).toEqual({
      name: '',
      description: '',
      game: 'TUNIC',
      requiresVersion: null,
      options: {},
      extraRoot: { name: value(''), requires: value({ version: 0.7 }) },
    })
  })

  it('skips empty documents and keeps the order of the others', () => {
    const { docs } = parsePlayerYaml('---\nname: A\n---\n---\nname: B\n---\n')
    expect(docs.map((d) => d.name)).toEqual(['A', 'B'])
  })

  it('gives no documents for a file it cannot hold losslessly', () => {
    expect(parsePlayerYaml('name: A\nname: B\n')).toEqual({
      docs: [],
      issues: [expect.objectContaining({ code: 'duplicate-key' })],
    })
    expect(parsePlayerYaml('name: A\n---\n- not a mapping\n')).toEqual({
      docs: [],
      issues: [{ severity: 'error', code: 'yaml-syntax', params: { doc: 2, line: 3 } }],
    })
    expect(parsePlayerYaml('game: TUNIC\nTUNIC:\n  1: one\n').docs).toEqual([])
    expect(parsePlayerYaml('true: x\n').docs).toEqual([])
    expect(parsePlayerYaml('game: TUNIC\nTUNIC: oops\n').docs).toEqual([])
  })

  it('preserves unknown root keys and unknown options through parse→render', () => {
    const source = [
      '# A comment that is lost, values are not',
      'name: Player{number}',
      'game: A Link to the Past',
      'requires:',
      '  version: 0.6.8',
      '  game:',
      '    A Link to the Past: 5.1.0',
      'quantity: 2',
      'my_tool_metadata: {exported_by: someone, at: 2026-10-17}',
      'triggers:',
      '  - option_category: A Link to the Past',
      '    option_name: dark_room_logic',
      '    option_result: lamp',
      '    options:',
      '      A Link to the Past:',
      '        swordless: {true: 50, false: 0}',
      'A Link to the Past:',
      '  progression_balancing: {50: 3, random: 1, normal: 0}',
      '  unknown_future_option: [1, 2.0, "3", yes, "no", ~, 0755, !!set {a}]',
      '  sprite:',
      '    Link: 1',
      '  item_links:',
      '    - name: Shared',
      '      item_pool: [Bow]',
      '      replacement_item: null',
      '  plando_texts: &texts [{at: x, text: "1:20"}]',
      '  plando_connections: *texts',
      '  timed: 1.5',
      'Factorio:',
      '  free_samples: {single_craft: 1}',
      '',
    ].join('\n')
    const { docs } = parsePlayerYaml(source)
    expect(docs).toHaveLength(1)
    const text = renderPlayerYaml(docs[0]!)
    expect(typed(text)).toEqual(typed(source))
    expect(text).toContain('2.0')
  })

  it('rename: parse → new name → render every document → join gives the same players', () => {
    const source = [
      'name: Alice',
      'game: TUNIC',
      'TUNIC: {hexagon_goal: 20, sword_progression: {true: 50}}',
      '---',
      'name: Bob',
      'game: TUNIC',
      'TUNIC: {fool_traps: "off"}',
      '',
    ].join('\n')
    const { docs } = parsePlayerYaml(source)
    const renamed = docs.map((d) => (d.name === 'Bob' ? { ...d, name: 'Robert' } : d))
    const joined = renamed.map((d) => renderPlayerYaml(d)).join('\n---\n')
    const expected = typed(source) as Map<string, unknown>[]
    expected[1]!.set('name', 'Robert')
    expect(typed(joined)).toEqual(expected)
  })
})

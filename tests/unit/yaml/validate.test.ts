import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeYamlBytes, loadYaml11 } from '@main/core/yaml/load'
import { parseTemplate } from '@main/core/yaml/template-parser'
import {
  gamesIn,
  validateLoadedYaml,
  validatePlayerDocs,
  validateSessionNames,
  type ValidationContext,
} from '@main/core/yaml/validate'
import { renderPlayerYaml } from '@main/core/yaml/writer'
import type { IssueCode } from '@shared/codes'
import { docFromSchema } from '@shared/studio-model'
import type { GameSchema, Issue, PlayerDoc, PlayerFile } from '@shared/types'

const TEMPLATES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const YAMLS = fileURLToPath(new URL('../../fixtures/yamls/', import.meta.url))
const TEMPLATE_FIXTURES = readdirSync(TEMPLATES)
  .filter((name) => name.endsWith('.yaml'))
  .sort()

const read = (name: string): string => readFileSync(join(TEMPLATES, name), 'utf8')
const yamlFixture = (name: string): string => decodeYamlBytes(readFileSync(join(YAMLS, name))).text

const TUNIC = parseTemplate(read('TUNIC.yaml'))
const ALTTP = parseTemplate(read('A Link to the Past.yaml'))

function ctxWith(...schemas: GameSchema[]): ValidationContext {
  return {
    installedGames: new Map(schemas.map((schema) => [schema.game, { worldVersion: null }])),
    apVersion: '0.6.8',
    schemaFor: (game) => schemas.find((schema) => schema.game === game),
    allowQuantity: false,
    plandoEnabled: ['bosses', 'connections', 'texts'],
  }
}

const CTX = ctxWith(TUNIC, ALTTP)

/** The PlayerDocs of one file's text. */
const check = (text: string, ctx: ValidationContext = CTX, fileName = 'Goat.yaml'): PlayerDoc[] =>
  validateLoadedYaml(loadYaml11(text), fileName, ctx)

const issuesOf = (text: string, ctx: ValidationContext = CTX): Issue[] =>
  check(text, ctx).flatMap((d) => d.issues)
const errorsOf = (text: string, ctx?: ValidationContext): Issue[] =>
  issuesOf(text, ctx).filter((issue) => issue.severity === 'error')

const doc = (...lines: string[]): string => [...lines, ''].join('\n')
const BASE = ['name: Goat', 'game: TUNIC', 'requires:', '  version: 0.6.8']

type IssueCase = [IssueCode, Issue['severity'], string, Partial<ValidationContext>?]

/** A minimal YAML per issue code of the YAML / game / name / requires / options families. */
const ISSUE_CASES: IssueCase[] = [
  ['yaml-syntax', 'error', doc('name: Goat', 'game: TUNIC', 'TUNIC:', '\thexagon_goal: 20')],
  ['duplicate-key', 'error', doc(...BASE, 'TUNIC: {}', 'name: Other')],
  ['no-game', 'error', doc('name: Goat', 'TUNIC: {}')],
  ['game-not-installed', 'error', doc('name: Goat', 'game: Tunic', 'Tunic: {}')],
  ['game-section-missing', 'error', doc(...BASE)],
  ['game-section-null', 'error', doc(...BASE, 'TUNIC:')],
  ['name-too-long', 'error', doc('name: VeryLongPlayerName{number}', 'game: TUNIC', 'TUNIC: {}')],
  ['name-reserved', 'error', doc('name: Archipelago', 'game: TUNIC', 'TUNIC: {}')],
  ['name-numeric', 'warning', doc("name: '1234'", 'game: TUNIC', 'TUNIC: {}')],
  [
    'name-duplicate',
    'error',
    doc('name: Bob', 'game: TUNIC', 'TUNIC: {}', '---', 'name: BOB', 'game: TUNIC', 'TUNIC: {}'),
  ],
  [
    'requires-version-format',
    'error',
    doc('name: Goat', 'game: TUNIC', 'requires:', '  version: 0.7', 'TUNIC: {}'),
  ],
  [
    'requires-version-too-new',
    'error',
    doc('name: Goat', 'game: TUNIC', 'requires:', '  version: 0.7.0', 'TUNIC: {}'),
  ],
  ['requires-plando-disabled', 'error', doc(...BASE, '  plando: bosses, items', 'TUNIC: {}')],
  [
    'requires-game-version',
    'error',
    doc(...BASE, '  game:', '    TUNIC: 9.0.0', 'TUNIC: {}'),
    { installedGames: new Map([['TUNIC', { worldVersion: '3.1.0' }]]) },
  ],
  ['option-unknown', 'warning', doc(...BASE, 'TUNIC:', '  not_an_option: 1')],
  ['option-invalid-value', 'error', doc(...BASE, 'TUNIC:', '  hexagon_goal: 500')],
  ['option-float', 'error', doc(...BASE, 'TUNIC:', '  hexagon_goal: 2.5')],
  [
    'weights-all-zero',
    'error',
    doc(...BASE, 'TUNIC:', '  sword_progression:', "    'false': 0", "    'true': 0"),
  ],
  ['quantity-disabled', 'error', doc(...BASE, 'quantity: 2', 'TUNIC: {}')],
  ['root-common-option', 'error', doc(...BASE, 'local_items: [Sword]', 'TUNIC: {}')],
  [
    'plando-items-disabled',
    'warning',
    doc(...BASE, 'TUNIC:', '  plando_items:', '    - item: Sword', '      location: Well'),
  ],
]

describe('validatePlayerDocs', () => {
  it.each(ISSUE_CASES)('detects %s (%s)', (code, severity, text, extra) => {
    const issues = issuesOf(text, { ...CTX, ...extra })
    expect(issues.map((issue) => issue.code)).toContain(code)
    expect(issues.find((issue) => issue.code === code)?.severity).toBe(severity)
  })

  it('accepts a valid hand-written player, warning on the unknown option only', () => {
    const [player] = check(yamlFixture('valid.yaml'))
    expect(player).toEqual({
      index: 0,
      name: 'Goat',
      games: [{ game: 'TUNIC', weight: 1 }],
      issues: [{ severity: 'warning', code: 'option-unknown', path: 'TUNIC.death_link_unknown_for_tunic' }],
    })
  })

  it('reports every problem of an invalid player, with its path', () => {
    const issues = check(yamlFixture('invalid.yaml'))[0]?.issues ?? []
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'name-reserved', path: 'name' }),
        expect.objectContaining({ code: 'option-invalid-value', path: 'quantity' }),
        expect.objectContaining({ code: 'root-common-option', path: 'local_items' }),
        expect.objectContaining({ code: 'requires-version-format', path: 'requires.version' }),
        expect.objectContaining({ code: 'option-float', path: 'TUNIC.hexagon_goal' }),
        expect.objectContaining({ code: 'option-invalid-value', path: 'TUNIC.sword_progression' }),
      ]),
    )
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
  })

  it('accepts BOM + CRLF + multi-doc: one PlayerDoc per non-empty document', () => {
    const docs = check(decodeYamlBytes(readFileSync(join(YAMLS, 'bom-crlf-multi.yaml'))).text)
    expect(docs.map((d) => [d.index, d.name, d.issues])).toEqual([
      [0, 'Alice', []],
      [1, 'Bob', []],
    ])
  })

  it('a file that does not load is one PlayerDoc carrying the YAML issues', () => {
    expect(check(yamlFixture('tabs.yaml'))).toEqual([
      {
        index: 0,
        name: null,
        games: [],
        issues: [{ severity: 'error', code: 'yaml-syntax', params: { line: 4, column: 1 } }],
      },
    ])
    expect(check('')).toEqual([])
  })

  it('takes the name from the file name when the YAML has none', () => {
    expect(check(doc('game: TUNIC', 'TUNIC: {}'), CTX, 'C:\\players\\Zelda.v2.yaml')[0]?.name).toBe(
      'Zelda.v2',
    )
    expect(check(doc('name: null', 'game: TUNIC', 'TUNIC: {}'), CTX, 'Link.yml')[0]?.name).toBe('Link')
  })

  it('checks names after placeholder substitution: 13 characters pass, 19 do not', () => {
    expect(issuesOf(doc('name: VeryLongName{number}', 'game: TUNIC', 'TUNIC: {}'))).toEqual([])
    expect(issuesOf(doc('name: VeryLongPlayerName{number}', 'game: TUNIC', 'TUNIC: {}'))).toEqual([
      {
        severity: 'error',
        code: 'name-too-long',
        path: 'name',
        params: { name: 'VeryLongPlayerName1', max: 16 },
      },
    ])
    // {NUMBER} is empty for the first one, {player} is the slot.
    expect(issuesOf(doc('name: SixteenCharName{NUMBER}', 'game: TUNIC', 'TUNIC: {}'))).toEqual([])
    expect(issuesOf(doc('name: "  Archipelago  "', 'game: TUNIC', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'name-reserved' }),
    ])
  })

  it('a name AP cannot read is an error', () => {
    expect(errorsOf(doc('name: 1234', 'game: TUNIC', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'name-numeric', path: 'name' }),
    ])
    expect(errorsOf(doc('name: Bob}', 'game: TUNIC', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'option-invalid-value', path: 'name' }),
    ])
  })

  it('a weighted name has no single name; each candidate is checked', () => {
    const [player] = check(doc('name:', '  Archipelago: 1', '  Bob: 1', 'game: TUNIC', 'TUNIC: {}'))
    expect(player?.name).toBeNull()
    expect(player?.issues).toEqual([expect.objectContaining({ code: 'name-reserved', path: 'name' })])
  })

  it('suggests the installed game whose name is closest', () => {
    expect(errorsOf(doc('name: Goat', 'game: Tunic', 'Tunic: {}'))).toEqual([
      {
        severity: 'error',
        code: 'game-not-installed',
        path: 'game',
        params: { game: 'Tunic', suggestion: 'TUNIC' },
      },
    ])
    expect(errorsOf(doc('name: Goat', 'game: Zork', 'Zork: {}'))).toEqual([
      { severity: 'error', code: 'game-not-installed', path: 'game', params: { game: 'Zork' } },
    ])
  })

  it('a weighted game checks each game of weight > 0 only', () => {
    const text = doc('name: Goat', 'game:', '  TUNIC: 2', '  Zork: 0', '  A Link to the Past: 1', 'TUNIC: {}')
    const [player] = check(text)
    expect(player?.games).toEqual([
      { game: 'TUNIC', weight: 2 },
      { game: 'A Link to the Past', weight: 1 },
    ])
    expect(player?.issues).toEqual([
      {
        severity: 'error',
        code: 'game-section-missing',
        path: 'A Link to the Past',
        params: { game: 'A Link to the Past' },
      },
    ])
    expect(errorsOf(doc('name: Goat', 'game:', '  TUNIC: 0', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'weights-all-zero', path: 'game' }),
    ])
  })

  it('requires: plando modules and world versions', () => {
    expect(errorsOf(doc(...BASE, '  plando: bosses, texts', 'TUNIC: {}'))).toEqual([])
    expect(errorsOf(doc(...BASE, '  plando: bosses, potatoes', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'requires-plando-disabled', params: { module: 'potatoes' } }),
    ])
    const installed = { ...CTX, installedGames: new Map([['TUNIC', { worldVersion: '3.1.0' }]]) }
    expect(errorsOf(doc(...BASE, '  game:', '    TUNIC: 3.0.0', 'TUNIC: {}'), installed)).toEqual([])
    expect(
      errorsOf(doc(...BASE, '  game:', '    TUNIC: {min: 1.0.0, max: 3.0.9}', 'TUNIC: {}'), installed),
    ).toEqual([
      {
        severity: 'error',
        code: 'requires-game-version',
        path: 'requires.game.TUNIC',
        params: { game: 'TUNIC', required: '3.0.9', installed: '3.1.0' },
      },
    ])
    // A game that is not installed is skipped, as Archipelago does.
    expect(errorsOf(doc(...BASE, '  game:', '    Zork: 9.9.9', 'TUNIC: {}'), installed)).toEqual([])
    expect(errorsOf(doc(...BASE, '  game:', '    TUNIC: 3.0', 'TUNIC: {}'), installed)).toEqual([
      expect.objectContaining({ code: 'requires-version-format', path: 'requires.game.TUNIC' }),
    ])
  })

  it('option values follow the rules of Toggle, Choice and Range', () => {
    const errors = (...section: string[]): IssueCode[] =>
      errorsOf(doc(...BASE, 'TUNIC:', ...section.map((line) => `  ${line}`))).map((issue) => issue.code)
    // Toggle
    expect(errors('sword_progression: yes', 'start_with_sword: enabled', 'hexagon_quest: random')).toEqual([])
    expect(errors('maskless: 1', 'lanternless: 0.5')).toEqual([])
    expect(errors('maskless: Random')).toEqual(['option-invalid-value'])
    expect(errors('maskless:')).toEqual(['option-invalid-value'])
    // Choice: names case-insensitively, random, ints (option ids); an unknown name may be an alias
    expect(errors('fool_traps: NORMAL', 'laurels_location: random', 'combat_logic: 1')).toEqual([])
    expect(issuesOf(doc(...BASE, 'TUNIC:', '  fool_traps: lots'))).toEqual([
      {
        severity: 'warning',
        code: 'option-invalid-value',
        path: 'TUNIC.fool_traps',
        params: { value: 'lots' },
      },
    ])
    // Range
    expect(
      errors(
        'hexagon_goal: random-range-low-5-50',
        'extra_hexagon_percentage: high',
        'progression_balancing: extreme',
        'local_fill: -1',
      ),
    ).toEqual([])
    expect(errors('hexagon_goal: "30"', 'extra_hexagon_percentage: default')).toEqual([])
    expect(errors('hexagon_goal: 0')).toEqual(['option-invalid-value'])
    expect(errors('hexagon_goal: random-range-0-50')).toEqual(['option-invalid-value'])
    expect(errors('hexagon_goal: random-wild')).toEqual(['option-invalid-value'])
    expect(errors('hexagon_goal: 5.0')).toEqual(['option-float'])
    expect(errors('hexagon_goal: "7.5"')).toEqual(['option-float'])
    expect(errors('hexagon_goal: true')).toEqual(['option-invalid-value'])
    expect(errors('extra_hexagon_percentage: false')).toEqual([])
  })

  it('weights: integers above 0, floats are truncated', () => {
    const issues = issuesOf(doc(...BASE, 'TUNIC:', '  fool_traps:', '    normal: 0.5', '    double: 1'))
    expect(issues).toEqual([
      { severity: 'warning', code: 'option-float', path: 'TUNIC.fool_traps', params: { value: 0.5 } },
    ])
    expect(errorsOf(doc(...BASE, 'TUNIC:', '  fool_traps:', '    normal: 0.5'))).toEqual([
      expect.objectContaining({ code: 'weights-all-zero', path: 'TUNIC.fool_traps' }),
    ])
    expect(errorsOf(doc(...BASE, 'TUNIC:', '  fool_traps:', '    normal: -5', '    double: 10'))).toEqual([
      expect.objectContaining({ code: 'option-invalid-value', path: 'TUNIC.fool_traps' }),
    ])
    expect(errorsOf(doc(...BASE, 'TUNIC:', '  fool_traps: []'))).toEqual([
      expect.objectContaining({ code: 'option-invalid-value', path: 'TUNIC.fool_traps' }),
    ])
    // An empty mapping keeps the default.
    expect(errorsOf(doc(...BASE, 'TUNIC:', '  fool_traps: {}'))).toEqual([])
  })

  it('a negative random range is mis-read by Archipelago: warned', () => {
    // red_clock_time: -60..60. `random-range--20-20` always gives 20 (Options.Range.custom_range).
    const alttp = (value: string): Issue[] =>
      issuesOf(
        doc('name: Goat', 'game: A Link to the Past', 'A Link to the Past:', `  red_clock_time: ${value}`),
      )
    expect(alttp('random-range--20-20')).toEqual([
      {
        severity: 'warning',
        code: 'option-invalid-value',
        path: 'A Link to the Past.red_clock_time',
        params: { value: 'random-range--20-20', reason: 'negative-random-range' },
      },
    ])
    expect(alttp('random-range-5--20')).toEqual([expect.objectContaining({ severity: 'error' })])
    expect(alttp('-20')).toEqual([])
  })

  it('quantity: allowed by the host, never below 1', () => {
    expect(errorsOf(doc(...BASE, 'quantity: 3', 'TUNIC: {}'), { ...CTX, allowQuantity: true })).toEqual([])
    expect(errorsOf(doc(...BASE, 'quantity: 1', 'TUNIC: {}'))).toEqual([])
    expect(errorsOf(doc(...BASE, 'quantity: two', 'TUNIC: {}'))).toEqual([
      expect.objectContaining({ code: 'option-invalid-value', path: 'quantity' }),
    ])
  })

  it('merge tags and options of a game without schema', () => {
    expect(errorsOf(doc(...BASE, 'TUNIC:', '  +local_items: [Sword]'))).toEqual([
      expect.objectContaining({ code: 'option-invalid-value', path: 'TUNIC.+local_items' }),
    ])
    const noSchema = { ...CTX, schemaFor: () => undefined }
    expect(issuesOf(doc(...BASE, 'TUNIC:', '  whatever: 12', '  triggers: []'), noSchema)).toEqual([])
    expect(issuesOf(doc(...BASE, 'TUNIC:', '  triggers: []'))).toEqual([])
  })

  it('a document that is not a mapping is a syntax error', () => {
    expect(check('- a\n- b\n')).toEqual([
      {
        index: 0,
        name: null,
        games: [],
        issues: [{ severity: 'error', code: 'yaml-syntax', params: { doc: 1 } }],
      },
    ])
  })

  it('works on documents given directly, skipping empty ones', () => {
    const docs = validatePlayerDocs([null, { name: 'A', game: 'TUNIC', TUNIC: {} }], 'x.yaml', CTX)
    expect(docs).toEqual([{ index: 0, name: 'A', games: [{ game: 'TUNIC', weight: 1 }], issues: [] }])
  })

  it.each(TEMPLATE_FIXTURES)('Studio defaults for %s validate without error issues', (f) => {
    const schema = parseTemplate(read(f))
    const text = renderPlayerYaml(docFromSchema(schema, 'Goat'), schema)
    const docs = validatePlayerDocs(loadYaml11(text).docs, 'Goat.yaml', ctxWith(schema))
    expect(docs).toHaveLength(1)
    expect(docs.flatMap((d) => d.issues).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('gamesIn', () => {
  it('lists the games a file can roll, for the schemas to fetch', () => {
    const { docs } = loadYaml11(yamlFixture('multi-doc.yaml'))
    expect(gamesIn(docs)).toEqual(['TUNIC'])
    expect(gamesIn([{ game: ['A', 'B'] }, { game: { C: 1, D: 0 } }, { game: 5 }, 'x', null])).toEqual([
      'A',
      'B',
      'C',
    ])
  })
})

describe('validateSessionNames', () => {
  const file = (storedName: string, ...names: (string | null)[]): PlayerFile => ({
    id: storedName,
    originalName: storedName,
    storedName,
    addedAt: '2026-10-17T00:00:00.000Z',
    docs: names.map((name, index) => ({ index, name, games: [], issues: [] })),
  })

  it('name "Player{number}" twice resolves to Player1/Player2 without duplicate', () => {
    expect(
      validateSessionNames([file('a.yaml', 'Player{number}'), file('b.yaml', 'Player{number}')]),
    ).toEqual([])
    expect(check(yamlFixture('multi-doc.yaml')).flatMap((d) => d.issues)).toEqual([])
  })

  it('flags names equal without case, once per name', () => {
    expect(
      validateSessionNames([file('a.yaml', 'Bob', 'Alice'), file('b.yaml', 'bob'), file('c.yaml', 'BOB')]),
    ).toEqual([{ severity: 'error', code: 'name-duplicate', params: { name: 'Bob', count: 3 } }])
  })

  it('compares the names Archipelago gives: placeholders resolved in file order, then cut to 16', () => {
    // Files are read sorted without case: B.yaml's Player{number} is the second one.
    expect(
      validateSessionNames([
        file('b.yaml', 'Player{number}'),
        file('A.yaml', 'Player{number}'),
        file('c.yaml', 'Player2'),
      ]),
    ).toEqual([{ severity: 'error', code: 'name-duplicate', params: { name: 'Player2', count: 2 } }])
    expect(validateSessionNames([file('a.yaml', 'P2'), file('b.yaml', 'P{player}')])).toEqual([
      { severity: 'error', code: 'name-duplicate', params: { name: 'P2', count: 2 } },
    ])
    expect(
      validateSessionNames([file('a.yaml', 'VeryLongPlayerName1'), file('b.yaml', 'VeryLongPlayerName2')]),
    ).toEqual([{ severity: 'error', code: 'name-duplicate', params: { name: 'VeryLongPlayerNa', count: 2 } }])
    expect(validateSessionNames([file('a.yaml', null, null)])).toEqual([])
  })
})

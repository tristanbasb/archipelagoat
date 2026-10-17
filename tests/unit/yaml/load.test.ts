import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeYamlBytes, loadYaml11, YamlFloat } from '@main/core/yaml/load'

const DIR = fileURLToPath(new URL('../../fixtures/yamls/', import.meta.url))
const bytes = (name: string): Buffer => readFileSync(join(DIR, name))

/** The single document of `text`, which must load without issues. */
function only(text: string): unknown {
  const { docs, issues } = loadYaml11(text)
  expect(issues).toEqual([])
  expect(docs).toHaveLength(1)
  return docs[0]
}

describe('decodeYamlBytes', () => {
  it('reads UTF-8 and drops its BOM, without issues', () => {
    expect(decodeYamlBytes(Buffer.from('\uFEFFname: Zoé\n', 'utf8'))).toEqual({
      text: 'name: Zoé\n',
      issues: [],
    })
    expect(decodeYamlBytes(Buffer.from('name: Zoé\n', 'utf8'))).toEqual({ text: 'name: Zoé\n', issues: [] })
  })

  it('reads UTF-16 LE and BE files by their BOM', () => {
    const expected = { text: 'name: Zoé\ngame: TUNIC\nTUNIC: {}\n', issues: [] }
    expect(decodeYamlBytes(bytes('utf16le-bom.yaml'))).toEqual(expected)
    expect(decodeYamlBytes(bytes('utf16be-bom.yaml'))).toEqual(expected)
  })

  it('decodes Windows-1252 é with encoding-fallback warning', () => {
    const { text, issues } = decodeYamlBytes(bytes('windows-1252.yaml'))
    expect(text).toBe('name: Héloïse\r\ndescription: café €\r\ngame: TUNIC\r\nTUNIC: {}\r\n')
    expect(issues).toEqual([{ severity: 'warning', code: 'encoding-fallback' }])
  })
})

describe('loadYaml11', () => {
  it('accepts BOM + CRLF + multi-doc, keeping the empty last document', () => {
    const { text, issues: decoding } = decodeYamlBytes(bytes('bom-crlf-multi.yaml'))
    expect(decoding).toEqual([])
    const { docs, issues } = loadYaml11(text)
    expect(issues).toEqual([])
    expect(docs).toEqual([
      { name: 'Alice', game: 'TUNIC', TUNIC: { hexagon_goal: 20 } },
      { name: 'Bob', game: 'TUNIC', TUNIC: {} },
      null,
    ])
  })

  it('also drops a BOM left in the text', () => {
    expect(only('\uFEFFname: Goat\n')).toEqual({ name: 'Goat' })
  })

  it('reads nothing from an empty or comment-only file', () => {
    expect(loadYaml11('')).toEqual({ docs: [], issues: [] })
    expect(loadYaml11('# nothing here\n')).toEqual({ docs: [], issues: [] })
  })

  it('flags tab indentation as yaml-syntax with line number', () => {
    const { text } = decodeYamlBytes(bytes('tabs.yaml'))
    const { docs, issues } = loadYaml11(text)
    expect(docs).toEqual([])
    expect(issues).toEqual([{ severity: 'error', code: 'yaml-syntax', params: { line: 4, column: 1 } }])
  })

  it('flags other syntax errors with their line', () => {
    expect(loadYaml11('name: Goat\ngame: a: b\n').issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'yaml-syntax',
        params: expect.objectContaining({ line: 2 }) as unknown,
      }),
    ])
  })

  it('flags duplicate keys, including the YAML 1.1 spellings of one boolean', () => {
    expect(loadYaml11('name: A\nname: B\n')).toEqual({
      docs: [],
      issues: [{ severity: 'error', code: 'duplicate-key', params: { key: 'name', line: 2, column: 1 } }],
    })
    expect(loadYaml11('T:\n  o:\n    yes: 1\n    true: 2\n').issues).toEqual([
      { severity: 'error', code: 'duplicate-key', params: { key: 'true', line: 4, column: 5 } },
    ])
    // An int and a string are two keys for PyYAML too.
    expect(only('1: a\n"1": b\n')).toEqual({ '1': 'b' })
  })

  it('flags `key` and `+key` in one mapping, as UniqueKeyLoader does', () => {
    expect(loadYaml11('T:\n  +local_items: [A]\n  local_items: [B]\n').issues).toEqual([
      { severity: 'error', code: 'duplicate-key', params: { key: 'local_items', line: 3, column: 3 } },
    ])
  })

  it('reads plain scalars exactly as PyYAML does', () => {
    const doc = only(
      [
        'bools: [yes, No, ON, off, true, FALSE]',
        // Booleans in the yaml package's YAML 1.1, strings for PyYAML.
        'strings: [y, n, Y, N, 1e5, 08, 0:20, 2020-1-1]',
        'ints: [0755, 1:20, 1_000, 0x1F, 0b11, +12]',
        'floats: [1.5, .5, 1:20.5, 2.5e-3]',
        'nulls: [~, null, Null, NULL]',
      ].join('\n'),
    ) as Record<string, unknown[]>
    expect(doc.bools).toEqual([true, false, true, false, true, false])
    expect(doc.strings).toEqual(['y', 'n', 'Y', 'N', '1e5', '08', '0:20', '2020-1-1'])
    expect(doc.ints).toEqual([493, 80, 1000, 31, 3, 12])
    expect(doc.floats).toEqual([1.5, 0.5, 80.5, 0.0025])
    expect(doc.nulls).toEqual([null, null, null, null])
    expect(only('t: 2020-01-02\n')).toEqual({ t: expect.any(Date) as unknown })
  })

  it('keeps a float that holds an integer apart from an int (Range refuses floats)', () => {
    const doc = only('a: 5.0\nb: 5\nc: 2.\n') as Record<string, unknown>
    expect(doc.a).toBeInstanceOf(YamlFloat)
    expect((doc.a as YamlFloat).value).toBe(5)
    expect(doc.b).toBe(5)
    expect(doc.c).toEqual(new YamlFloat(2))
    expect(JSON.stringify(doc)).toBe('{"a":5,"b":5,"c":2}')
  })

  it('turns sets into lists and keeps non-string keys as strings', () => {
    expect(only('s: !!set {a, b}\nw:\n  true: 50\n  5: 1\n')).toEqual({
      s: ['a', 'b'],
      w: { true: 50, 5: 1 },
    })
  })

  it('resolves aliases', () => {
    expect(only('a: &x [1, 2]\nb: *x\n')).toEqual({ a: [1, 2], b: [1, 2] })
  })

  it('refuses aliases that never end or expand without bound', () => {
    const ten = (name: string): string => `[${Array<string>(10).fill(`*${name}`).join(', ')}]`
    const bomb = ['a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]', `b: &b ${ten('a')}`, `c: &c ${ten('b')}`]
    bomb.push(`d: &d ${ten('c')}`, `e: &e ${ten('d')}`, `f: ${ten('e')}`)
    for (const text of ['a: &x [*x]\n', 'a: &x {b: [*x]}\n', bomb.join('\n')]) {
      expect(loadYaml11(text)).toEqual({
        docs: [],
        issues: [{ severity: 'error', code: 'yaml-syntax', params: { reason: 'aliases' } }],
      })
    }
  })

  it('refuses what PyYAML SafeLoader cannot construct', () => {
    for (const text of [
      'a: !!python/tuple [1, 2]\n',
      'a: !foo bar\n',
      'a: =\n',
      'base: &b {x: 1}\nT:\n  <<: *b\n',
    ]) {
      expect(loadYaml11(text)).toEqual({
        docs: [],
        issues: [expect.objectContaining({ severity: 'error', code: 'yaml-syntax' })],
      })
    }
  })
})

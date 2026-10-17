import { applyPreset, docFromSchema, setOptionValue } from '@shared/studio-model'
import type { GameSchema, OptionSchema } from '@shared/types'

const option = (key: string, kind: OptionSchema['kind'], value: unknown): OptionSchema => ({
  key,
  group: 'Game Options',
  doc: '',
  kind,
  default: value,
  choices: [],
  range: null,
  specialNames: {},
  confidence: 'inferred',
})

const SCHEMA: GameSchema = {
  game: 'Test Game',
  source: 'local',
  apVersion: '0.6.8',
  groups: [
    {
      name: 'Game Options',
      options: [option('goal', 'choice', 'ganon'), option('death_link', 'toggle', false)],
    },
    {
      name: 'Item & Location Options',
      options: [option('start_inventory', 'dict', { Bomb: 10 }), option('mystery', 'free', null)],
    },
  ],
  presets: { Easy: { goal: 'crystals', death_link: true } },
}

describe('studio model', () => {
  it('docFromSchema: the default of each option, the schema version, nothing else', () => {
    const doc = docFromSchema(SCHEMA, 'Goat')
    expect(doc).toEqual({
      name: 'Goat',
      description: '',
      game: 'Test Game',
      requiresVersion: '0.6.8',
      options: {
        goal: { mode: 'value', value: 'ganon' },
        death_link: { mode: 'value', value: false },
        start_inventory: { mode: 'value', value: { Bomb: 10 } },
      },
      extraRoot: {},
    })
    // The doc owns its values: editing them leaves the schema alone.
    ;(doc.options.start_inventory as { value: Record<string, number> }).value.Bomb = 1
    expect(SCHEMA.groups[1]?.options[0]?.default).toEqual({ Bomb: 10 })
    expect(docFromSchema({ ...SCHEMA, apVersion: null }, 'X').requiresVersion).toBeNull()
  })

  it('applyPreset sets the values of the preset over the others, without touching the input', () => {
    const doc = docFromSchema(SCHEMA, 'Goat')
    const easy = applyPreset(doc, SCHEMA.presets.Easy!)
    expect(easy.options).toEqual({
      goal: { mode: 'value', value: 'crystals' },
      death_link: { mode: 'value', value: true },
      start_inventory: { mode: 'value', value: { Bomb: 10 } },
    })
    expect(doc.options.goal).toEqual({ mode: 'value', value: 'ganon' })
    expect(applyPreset(doc, { extra: undefined })).toEqual(doc)
  })

  it('setOptionValue replaces one option, without touching the input', () => {
    const doc = docFromSchema(SCHEMA, 'Goat')
    const next = setOptionValue(doc, 'goal', { mode: 'weighted', weights: { ganon: 50, crystals: 50 } })
    expect(next.options.goal).toEqual({ mode: 'weighted', weights: { ganon: 50, crystals: 50 } })
    expect(doc.options.goal).toEqual({ mode: 'value', value: 'ganon' })
    const odd = setOptionValue(doc, '__proto__', { mode: 'raw', yaml: 'x: 1' }).options
    expect(Object.getOwnPropertyDescriptor(odd, '__proto__')?.value).toEqual({ mode: 'raw', yaml: 'x: 1' })
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype)
  })
})

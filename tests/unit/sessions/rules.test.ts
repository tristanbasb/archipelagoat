import { join } from 'node:path'
import { buildSessionSettingsEntries } from '@main/core/sessions/rules'
import { defaultRules, RULE_PRESETS } from '@shared/rules'
import type { Rules } from '@shared/types'

const ROM = join(process.cwd(), 'Mes ROMs', 'Zelda no Densetsu (J).sfc')

const valueAt = (entries: { path: string[]; value: unknown }[], path: string): unknown =>
  entries.find((entry) => entry.path.join('.') === path)?.value

describe('buildSessionSettingsEntries', () => {
  it('buildSessionSettingsEntries writes absolute lttp_options.rom_file and disable_item_cheat', () => {
    const entries = buildSessionSettingsEntries(
      defaultRules(),
      { password: null, serverPassword: null },
      { 'lttp_options.rom_file': ROM },
    )
    expect(entries).toContainEqual({ path: ['lttp_options', 'rom_file'], value: ROM })
    expect(valueAt(entries, 'server_options.disable_item_cheat')).toBe(true)
    const cheating = buildSessionSettingsEntries(
      { ...defaultRules(), itemCheat: true },
      { password: null, serverPassword: null },
      {},
    )
    expect(valueAt(cheating, 'server_options.disable_item_cheat')).toBe(false)
    expect(cheating.some((entry) => entry.path.includes('rom_file'))).toBe(false)
  })

  it('writes every generator and server option of the rules, with the passwords', () => {
    const rules: Rules = {
      ...RULE_PRESETS.race,
      hintCost: 25,
      locationCheckPoints: 3,
      releaseMode: 'goal',
      collectMode: 'disabled',
      remainingMode: 'enabled',
      countdownMode: 'disabled',
      autoShutdown: 600,
      plando: ['items', 'bosses'],
    }
    const entries = buildSessionSettingsEntries(
      rules,
      { password: 'join me', serverPassword: 'admin #1' },
      {},
    )
    expect(entries).toEqual([
      { path: ['generator', 'spoiler'], value: 0 },
      { path: ['generator', 'race'], value: 1 },
      { path: ['generator', 'plando_options'], value: 'items, bosses' },
      { path: ['server_options', 'password'], value: 'join me' },
      { path: ['server_options', 'server_password'], value: 'admin #1' },
      { path: ['server_options', 'hint_cost'], value: 25 },
      { path: ['server_options', 'location_check_points'], value: 3 },
      { path: ['server_options', 'release_mode'], value: 'goal' },
      { path: ['server_options', 'collect_mode'], value: 'disabled' },
      { path: ['server_options', 'remaining_mode'], value: 'enabled' },
      { path: ['server_options', 'countdown_mode'], value: 'disabled' },
      { path: ['server_options', 'auto_shutdown'], value: 600 },
      { path: ['server_options', 'compatibility'], value: 0 },
      { path: ['server_options', 'disable_item_cheat'], value: true },
    ])
  })

  it('casual rules: no race, no passwords (null), the default plando modules', () => {
    const entries = buildSessionSettingsEntries(defaultRules(), { password: null, serverPassword: null }, {})
    expect(valueAt(entries, 'generator.race')).toBe(0)
    expect(valueAt(entries, 'generator.spoiler')).toBe(3)
    expect(valueAt(entries, 'generator.plando_options')).toBe('bosses, connections, texts')
    expect(valueAt(entries, 'server_options.password')).toBeNull()
    expect(valueAt(entries, 'server_options.server_password')).toBeNull()
    expect(valueAt(entries, 'server_options.compatibility')).toBe(2)
    const none = buildSessionSettingsEntries(
      { ...defaultRules(), plando: [] },
      { password: null, serverPassword: null },
      {},
    )
    expect(valueAt(none, 'generator.plando_options')).toBe('')
  })

  it('one rom_file entry per ROM; a relative path or a bad key is refused', () => {
    const other = join(process.cwd(), 'roms', 'oot.z64')
    const entries = buildSessionSettingsEntries(
      defaultRules(),
      { password: null, serverPassword: null },
      { 'lttp_options.rom_file': ROM, 'oot_options.rom_file': other },
    )
    expect(entries.slice(-2)).toEqual([
      { path: ['lttp_options', 'rom_file'], value: ROM },
      { path: ['oot_options', 'rom_file'], value: other },
    ])
    expect(() =>
      buildSessionSettingsEntries(
        defaultRules(),
        { password: null, serverPassword: null },
        { 'lttp_options.rom_file': 'roms/zelda.sfc' },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() =>
      buildSessionSettingsEntries(
        defaultRules(),
        { password: null, serverPassword: null },
        { rom_file: ROM },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
